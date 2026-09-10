import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import { snapshotChess } from "../chess.js";
import { MAX_ANALYSIS_DEPTH, MAX_MULTIPV } from "../domain.js";
import { validateAnalysisLines } from "../analysis-boundary.js";
import { readStockfishConfig } from "./stockfish-config.js";
import { stockfish } from "./stockfish.js";
import { lc0 } from "./lc0.js";
import type {
  EngineAnalysis,
  EngineId,
  EngineLine,
  EngineMeta,
  EngineMode,
  EngineOutcome,
  EngineRequest,
} from "./types.js";

export type EnginePosition = {
  fen: string;
  initialFen: string;
  moves: readonly string[];
};

export type EngineAdapter = {
  id: EngineId;
  analyze(
    position: EnginePosition,
    request: EngineRequest,
    signal?: AbortSignal,
  ): Promise<EngineLine[]>;
  metadata(): EngineMeta | Promise<EngineMeta>;
  quit(): Promise<void>;
};

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const packageJson = resolve(here, "../../package.json");
const ENGINE_IDS: readonly EngineId[] = ["stockfish", "lc0"];

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function modeValue(value: unknown, label: string): EngineMode {
  if (value === "stockfish" || value === "lc0" || value === "both") return value;
  throw new Error(`${label} must be one of stockfish, lc0, both`);
}

export function resolveEngineMode(value?: EngineMode | string): EngineMode {
  if (value !== undefined) return modeValue(value, "engine mode");
  const environment = process.env.ENGINE_MODE;
  if (environment !== undefined && environment.trim() !== "") {
    return modeValue(environment, "ENGINE_MODE");
  }
  let configured: unknown;
  try {
    const json = JSON.parse(readFileSync(packageJson, "utf8")) as Record<string, unknown>;
    const analysis = json.analysis;
    configured = analysis && typeof analysis === "object" && !Array.isArray(analysis)
      ? (analysis as Record<string, unknown>).mode
      : undefined;
  } catch {
    configured = undefined;
  }
  return configured === undefined ? "both" : modeValue(configured, "package analysis.mode");
}

function selected(mode: EngineMode): EngineId[] {
  return mode === "both" ? [...ENGINE_IDS] : [mode];
}

function errorOutcome(error: unknown): EngineOutcome<EngineLine[]> {
  const reason = asError(error);
  const code = typeof (reason as Error & { code?: unknown }).code === "string"
    ? (reason as Error & { code: string }).code
    : "ENGINE_ERROR";
  const message = reason.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1024) || "engine failed";
  return { status: "error", error: { code: code.slice(0, 64), message } };
}

function isAbort(signal: AbortSignal | undefined): Error | null {
  if (!signal?.aborted) return null;
  return signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
}

function stockfishAdapter(): EngineAdapter {
  return {
    id: "stockfish",
    analyze: (position, request, signal) => stockfish.analyze(
      position.fen,
      request.depth,
      request.multipv,
      signal,
      {
        initialFen: position.initialFen,
        moves: position.moves,
      },
    ),
    metadata: () => {
      const config = readStockfishConfig();
      return { id: "stockfish", version: config.version, weightsSha256: null, backend: "wasm" };
    },
    quit: () => stockfish.quit(),
  };
}

function lc0Adapter(): EngineAdapter {
  return {
    id: "lc0",
    analyze: (position, request, signal) => lc0.analyze(position.initialFen, request, position.moves, signal),
    metadata: () => lc0.metadata(),
    quit: () => lc0.quit(),
  };
}

type EngineLimits = {
  depth: number | null;
  movetimeMs: number | null;
  multipv: number;
};

function requestLimits(request: EngineRequest, id: EngineId): EngineLimits {
  return { depth: id === "stockfish" ? request.depth : null, movetimeMs: id === "lc0" ? request.movetimeMs : null, multipv: request.multipv };
}

function validateRequest(request: EngineRequest): void {
  if (!request || typeof request !== "object") throw new Error("engine request must be an object");
  for (const [name, value] of [["depth", request.depth], ["multipv", request.multipv], ["movetimeMs", request.movetimeMs]] as const) {
    const maximum = name === "depth" ? MAX_ANALYSIS_DEPTH : name === "multipv" ? MAX_MULTIPV : 30_000;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`invalid engine request ${name}`);
  }
}

function validateLines(lines: readonly EngineLine[], fen: string, multipv: number, gameOver: boolean): void {
  validateAnalysisLines(lines, multipv);
  if (lines.length === 0) {
    if (!gameOver) throw new Error("engine returned no analysis lines");
    return;
  }
  const roots = new Set<string>();
  for (const line of lines) {
    if (line.pv.length === 0) {
      if (!gameOver) throw new Error("engine returned an empty principal variation");
      continue;
    }
    const rootMove = line.pv[0]!;
    if (roots.has(rootMove)) throw new Error("engine returned duplicate principal variations");
    roots.add(rootMove);
    const replay = new Chess(fen);
    for (const move of line.pv) {
      if (/[\r\n]/.test(move) || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw new Error("engine returned an invalid principal variation");
      try { replay.move(move); } catch { throw new Error("engine returned an illegal principal variation"); }
    }
  }
}

export function createEngineAnalyzer(adapters?: Partial<Record<EngineId, EngineAdapter>>): {
  analyzeEngines(chess: Chess, request: EngineRequest, signal?: AbortSignal): Promise<EngineAnalysis>;
  quitEngines(): Promise<void>;
} {
  const registered: Record<EngineId, EngineAdapter> = {
    stockfish: adapters?.stockfish ?? stockfishAdapter(),
    lc0: adapters?.lc0 ?? lc0Adapter(),
  };
  const analyzeEngines = async (chess: Chess, request: EngineRequest, signal?: AbortSignal): Promise<EngineAnalysis> => {
    validateRequest(request);
    const aborted = isAbort(signal);
    if (aborted) throw aborted;
    const position = snapshotChess(chess);
    const root = snapshotChess(position);
    const moves = position.history({ verbose: true }).map((move) => move.lan);
    while (root.undo()) {}
    const initialFen = root.fen();
    const mode = resolveEngineMode(request.mode);
    const ids = selected(mode);
    const run = async (id: EngineId): Promise<EngineOutcome<EngineLine[]>> => {
      const started = performance.now();
      try {
        const result = await registered[id].analyze({ fen: position.fen(), initialFen, moves: [...moves] }, { ...request, ...(request.mode !== undefined ? { mode: request.mode } : {}) }, signal);
        const copied = result.map((line) => ({ ...line, pv: [...line.pv], wdl: line.wdl ? [...line.wdl] as [number, number, number] : null }));
        validateLines(copied, position.fen(), request.multipv, position.isGameOver());
        const meta = await registered[id].metadata();
        return { status: "ok", meta, result: copied, elapsedMs: Math.max(0, Math.round(performance.now() - started)), limits: requestLimits(request, id) };
      } catch (error) {
        const cancelled = isAbort(signal);
        if (cancelled) throw cancelled;
        return errorOutcome(error);
      }
    };
    const outcomes = await Promise.all(ids.map(async (id) => [id, await run(id)] as const));
    const cancelled = isAbort(signal);
    if (cancelled) throw cancelled;
    const engines: Record<EngineId, EngineOutcome<EngineLine[]>> = {
      stockfish: { status: "not_requested" },
      lc0: { status: "not_requested" },
    };
    for (const [id, outcome] of outcomes) engines[id] = outcome;
    const enginesUsed = ids.filter((id) => engines[id].status === "ok");
    if (enginesUsed.length === 0) {
      const errors = ids.flatMap((id) => engines[id].status === "error" ? [engines[id].error.message] : []);
      throw new Error(`all requested engines failed${errors.length ? `: ${errors.join("; ")}` : ""}`);
    }
    return { mode, partial: mode === "both" && enginesUsed.length !== ids.length, enginesUsed, engines };
  };
  return {
    analyzeEngines,
    quitEngines: () => Promise.allSettled(ENGINE_IDS.map((id) => registered[id].quit())).then((results) => {
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length === 1) throw asError(errors[0]);
      if (errors.length > 1) throw new AggregateError(errors, "engine shutdown failed");
    }),
  };
}

const defaultAnalyzer = createEngineAnalyzer();
export const analyzeEngines = defaultAnalyzer.analyzeEngines;
export const quitEngines = defaultAnalyzer.quitEngines;
