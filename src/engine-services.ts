import type { Chess } from "chess.js";
import { snapshotChess } from "./chess.js";
import { validateAnalysisLines } from "./analysis-boundary.js";
import { ChessError } from "./errors.js";
import { resolveEngineMode } from "./engines/analysis.js";
import type { EngineAnalysis, EngineId, EngineRequest } from "./engines/types.js";
import type { AnalysisServices, CandidateServices } from "./services.js";
import type { EngineCandidateSet } from "./engine-consensus.js";
import type { LichessOpts } from "./intents.js";

const IDS = ["stockfish", "lc0"] as const;

export function validateEngineAnalysis(value: EngineAnalysis, request: EngineRequest): void {
  const mode = resolveEngineMode(request.mode);
  if (!value || value.mode !== mode || !value.engines || !Array.isArray(value.enginesUsed)) {
    throw new RangeError("invalid engine analysis envelope");
  }
  const successful: EngineId[] = [];
  for (const id of IDS) {
    const outcome = value.engines[id];
    const requested = mode === "both" || mode === id;
    if (!outcome || (!requested && outcome.status !== "not_requested") ||
        (requested && outcome.status === "not_requested")) {
      throw new RangeError("engine analysis does not match requested mode");
    }
    if (outcome.status === "ok") {
      if (!outcome.meta || outcome.meta.id !== id ||
          typeof outcome.meta.version !== "string" || !outcome.meta.version ||
          typeof outcome.meta.backend !== "string" || !outcome.meta.backend ||
          !(outcome.meta.weightsSha256 === null || (typeof outcome.meta.weightsSha256 === "string" && /^[a-f0-9]{64}$/.test(outcome.meta.weightsSha256))) ||
          !Number.isFinite(outcome.elapsedMs) || outcome.elapsedMs < 0 ||
          !outcome.limits || outcome.limits.multipv !== request.multipv ||
          outcome.limits.depth !== (id === "stockfish" ? request.depth : null) ||
          outcome.limits.movetimeMs !== (id === "lc0" ? request.movetimeMs : null)) {
        throw new RangeError("invalid engine analysis metadata");
      }
      validateAnalysisLines(outcome.result, request.multipv);
      successful.push(id);
    } else if (outcome.status === "error") {
      if (!outcome.error || typeof outcome.error.code !== "string" || !outcome.error.code ||
          typeof outcome.error.message !== "string" || !outcome.error.message || outcome.error.message.length > 1024) {
        throw new RangeError("invalid engine analysis error");
      }
    } else if (outcome.status !== "not_requested") {
      throw new RangeError("invalid engine analysis status");
    }
  }
  if (!successful.length || value.enginesUsed.length !== successful.length ||
      !successful.every((id, index) => value.enginesUsed[index] === id) ||
      value.partial !== (mode === "both" && successful.length === 1)) {
    throw new RangeError("inconsistent engine analysis summary");
  }
}

export async function analyzeWithEngines(
  services: Pick<AnalysisServices, "analyze" | "analyzeEngines">,
  chess: Chess,
  request: EngineRequest,
  signal?: AbortSignal,
): Promise<EngineAnalysis> {
  request = { ...request };
  signal?.throwIfAborted();
  const position = snapshotChess(chess);
  const mode = resolveEngineMode(request.mode);
  const resolved = { ...request, mode };
  let analysis: EngineAnalysis;
  if (services.analyzeEngines) {
    analysis = structuredClone(await services.analyzeEngines(position, { ...resolved }, signal));
  } else {
    if (mode === "lc0") throw new ChessError("ENGINE_UNAVAILABLE", "injected services do not provide Lc0 analysis");
    const started = performance.now();
    const result = structuredClone(await services.analyze(position.fen(), request.depth, request.multipv, signal));
    analysis = {
      mode,
      partial: mode === "both",
      enginesUsed: ["stockfish"],
      engines: {
        stockfish: {
          status: "ok", result,
          meta: { id: "stockfish", version: "injected", backend: "injected", weightsSha256: null },
          elapsedMs: performance.now() - started,
          limits: { depth: request.depth, multipv: request.multipv, movetimeMs: null },
        },
        lc0: mode === "both"
          ? { status: "error", error: { code: "ENGINE_UNAVAILABLE", message: "injected services do not provide Lc0 analysis" } }
          : { status: "not_requested" },
      },
    };
  }
  signal?.throwIfAborted();
  validateEngineAnalysis(analysis, resolved);
  return analysis;
}

export async function computeWithEngines(
  services: Pick<CandidateServices, "computeCandidates" | "computeEngineCandidates">,
  chess: Chess,
  elo: number,
  request: EngineRequest,
  maiaTopN: number,
  lichess?: LichessOpts | null,
  signal?: AbortSignal,
): Promise<EngineCandidateSet> {
  request = { ...request };
  signal?.throwIfAborted();
  const position = snapshotChess(chess);
  const mode = resolveEngineMode(request.mode);
  if (services.computeEngineCandidates) {
    const computed = structuredClone(await services.computeEngineCandidates(position, elo, { ...request, mode }, maiaTopN, lichess, signal));
    signal?.throwIfAborted();
    validateEngineAnalysis(computed, { ...request, mode });
    return computed;
  }
  if (mode === "lc0") throw new ChessError("ENGINE_UNAVAILABLE", "injected services do not provide Lc0 candidates");
  const started = performance.now();
  const computed = structuredClone(await services.computeCandidates(position, elo, request.depth, request.multipv, maiaTopN, lichess, signal));
  signal?.throwIfAborted();
  return {
    mode,
    partial: mode === "both",
    enginesUsed: ["stockfish"],
    engines: {
      stockfish: {
        status: "ok", result: [],
        meta: { id: "stockfish", version: "injected", backend: "injected", weightsSha256: null },
        elapsedMs: performance.now() - started,
        limits: { depth: request.depth, multipv: request.multipv, movetimeMs: null },
      },
      lc0: mode === "both"
        ? { status: "error", error: { code: "ENGINE_UNAVAILABLE", message: "injected services do not provide Lc0 candidates" } }
        : { status: "not_requested" },
    },
    moveSensitivity: { stockfish: computed.moveSensitivity, lc0: null },
    candidates: computed.candidates.map((candidate) => ({
      ...candidate,
      objective: { byEngine: { stockfish: candidate.objective, lc0: null } },
      consensusRank: null, consensusScore: 0, support: 0,
    })),
  };
}
