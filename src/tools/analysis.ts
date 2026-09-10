import type { McpServer } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import { validateAnalysisLines } from "../analysis-boundary.js";
import { validateHumanMoves } from "../human-boundary.js";
import { drawResult, parseMove, playParsedMove, pvToSan, snapshotChess } from "../chess.js";
import { ANALYSIS_PRESETS, classifyCpLoss, evalToCp, negateEval, toEval } from "../eval.js";
import { ChessError } from "../errors.js";
import { analyzeWithEngines } from "../engine-services.js";
import type { EngineAnalysis, EngineId, EngineLine, EngineOutcome, EngineRequest } from "../engines/types.js";
import type { AppServices } from "../services.js";
import { TOOL_INPUT_SCHEMAS } from "../tool-inputs.js";
import { TOOL_META } from "../tool-meta.js";
import { safeHandler, toolResult } from "../tool-result.js";
import { TOOL_OUTPUT_SCHEMAS } from "../tool-schemas.js";
import { legalMoveMap } from "./move-boundary.js";

type PositionAnalysis = z.output<typeof TOOL_OUTPUT_SCHEMAS.position_analyze>;
type HumanMoveDistribution = z.output<typeof TOOL_OUTPUT_SCHEMAS.human_move_distribution>;
type MoveEvaluation = z.output<typeof TOOL_OUTPUT_SCHEMAS.move_evaluate>["results"][number];
type AnalysisServices = Pick<AppServices, "games" | "analyze" | "analyzeEngines" | "humanMoveDistribution">;

const ENGINE_IDS = ["stockfish", "lc0"] as const satisfies readonly EngineId[];
const MOVETIME_BY_LEVEL = { fast: 1_000, normal: 3_000, deep: 10_000 } as const;

function completePvSan(chess: Parameters<typeof pvToSan>[0], pv: readonly string[]): string[] {
  const san = pvToSan(chess, pv);
  if (san.length !== pv.length) throw new RangeError("invalid analysis PV");
  return san;
}

function selectedRequest(
  analysisLevel: keyof typeof ANALYSIS_PRESETS,
  depth: number | undefined,
  multipv: number | undefined,
  engineMode: EngineRequest["mode"],
  movetimeMs: number | undefined,
): EngineRequest {
  const preset = ANALYSIS_PRESETS[analysisLevel];
  return {
    ...(engineMode === undefined ? {} : { mode: engineMode }),
    depth: depth ?? preset.depth,
    multipv: multipv ?? preset.multipv,
    movetimeMs: movetimeMs ?? MOVETIME_BY_LEVEL[analysisLevel],
  };
}

type OutputEngineOutcome = PositionAnalysis["engines"]["stockfish"];
function outputEngineOutcome(chess: Parameters<typeof completePvSan>[0], outcome: EngineOutcome<EngineLine[]>): OutputEngineOutcome {
  if (outcome.status !== "ok") return outcome;
  return { ...outcome, result: outcome.result.map((line) => ({ ...line, pvSan: completePvSan(chess, line.pv) })) };
}

function positionConsensus(chess: Parameters<typeof completePvSan>[0], analysis: EngineAnalysis): PositionAnalysis["consensus"] {
  const scores = new Map<string, { score: number; support: number }>();
  let successful = 0;
  for (const id of ENGINE_IDS) {
    const outcome = analysis.engines[id];
    if (outcome.status !== "ok") continue;
    successful += 1;
    for (const line of outcome.result) {
      const move = line.pv[0];
      if (!move) continue;
      const current = scores.get(move) ?? { score: 0, support: 0 };
      current.score += 1 / (60 + line.multipv);
      current.support += 1;
      scores.set(move, current);
    }
  }
  if (!successful) return [];
  const legal = new Map(chess.moves({ verbose: true }).map((move) => [move.lan, move.san]));
  return [...scores.entries()]
    .filter(([uci]) => legal.has(uci))
    .map(([uci, value]) => ({ uci, san: legal.get(uci)!, rank: 0, score: value.score / successful, support: value.support }))
    .sort((left, right) => right.score - left.score || right.support - left.support || left.uci.localeCompare(right.uci))
    .slice(0, 10)
    .map((line, index) => ({ ...line, rank: index + 1 }));
}

function positionPayload(gameId: string, revision: number, chess: Parameters<typeof completePvSan>[0], analysisLevel: keyof typeof ANALYSIS_PRESETS, analysis: EngineAnalysis): PositionAnalysis {
  return {
    game_id: gameId, fen: chess.fen(), turn: chess.turn(), revision, analysis_level: analysisLevel,
    mode: analysis.mode, partial: analysis.partial, enginesUsed: analysis.enginesUsed,
    engines: { stockfish: outputEngineOutcome(chess, analysis.engines.stockfish), lc0: outputEngineOutcome(chess, analysis.engines.lc0) },
    consensus: positionConsensus(chess, analysis),
  };
}

type MoveEngineEvaluation = MoveEvaluation["engines"]["stockfish"];
function moveEngineError(outcome: EngineOutcome<EngineLine[]>): MoveEngineEvaluation {
  if (outcome.status === "not_requested") return outcome;
  if (outcome.status === "error") return outcome;
  throw new Error("successful engine outcome requires a selected line");
}
function moveEngineResult(chess: Parameters<typeof completePvSan>[0], before: EngineOutcome<EngineLine[]>, after: EngineOutcome<EngineLine[]>): MoveEngineEvaluation {
  if (before.status !== "ok") return moveEngineError(before);
  if (after.status !== "ok") return moveEngineError(after);
  validateAnalysisLines(before.result, 1);
  validateAnalysisLines(after.result, 1);
  const beforeEval = before.result[0] ? toEval(before.result[0]) : null;
  const afterEval = after.result[0] ? toEval(after.result[0]) : null;
  const moverEval = afterEval ? negateEval(afterEval) : null;
  const bestCp = beforeEval ? evalToCp(beforeEval) : null;
  const scoreCp = moverEval?.type === "cp" ? moverEval.value : null;
  const scoreMate = moverEval?.type === "mate" ? moverEval.plies : null;
  const cpLoss = bestCp !== null && scoreCp !== null ? bestCp - scoreCp : null;
  const line = after.result[0];
  const pv = line?.pv ?? [];
  const wdl = line?.wdl;
  return { status: "ok", scoreCp, scoreMate, wdl: wdl ? [wdl[2], wdl[1], wdl[0]] : null, bestCp, cpLoss, classification: cpLoss !== null ? classifyCpLoss(cpLoss) : null, pv, pvSan: completePvSan(chess, pv) };
}
function terminalEngineResult(before: EngineOutcome<EngineLine[]>, result: "checkmate" | "stalemate" | "insufficient_material" | "threefold_repetition" | "fifty_move_rule" | "draw"): MoveEngineEvaluation {
  if (before.status !== "ok") return moveEngineError(before);
  validateAnalysisLines(before.result, 1);
  const bestEval = before.result[0] ? toEval(before.result[0]) : null;
  const bestCp = bestEval ? evalToCp(bestEval) : null;
  if (result === "checkmate") {
    return { status: "ok", scoreCp: null, scoreMate: 0, wdl: [1_000, 0, 0], bestCp, cpLoss: null, classification: "best", pv: [], pvSan: [] };
  }
  return { status: "ok", scoreCp: 0, scoreMate: null, wdl: [0, 1_000, 0], bestCp, cpLoss: bestCp, classification: bestCp !== null ? classifyCpLoss(bestCp) : null, pv: [], pvSan: [] };
}
function terminalEngineResults(before: EngineAnalysis, result: "checkmate" | "stalemate" | "insufficient_material" | "threefold_repetition" | "fifty_move_rule" | "draw"): MoveEvaluation["engines"] {
  return { stockfish: terminalEngineResult(before.engines.stockfish, result), lc0: terminalEngineResult(before.engines.lc0, result) };
}
function analysisError(outcome: MoveEngineEvaluation): Error | null {
  return outcome.status === "error" ? new Error(`${outcome.error.code}: ${outcome.error.message}`) : null;
}

export function registerAnalysisTools(server: McpServer, services: AnalysisServices): void {
  server.registerTool("position_analyze", {
    ...TOOL_META.position_analyze, inputSchema: TOOL_INPUT_SCHEMAS.position_analyze, outputSchema: TOOL_OUTPUT_SCHEMAS.position_analyze,
  }, safeHandler(TOOL_INPUT_SCHEMAS.position_analyze, TOOL_OUTPUT_SCHEMAS.position_analyze, async ({ game_id, analysis_level, depth, multipv, engine_mode, movetime_ms }, signal) => {
    const { chess, revision } = services.games.getSnapshot(game_id);
    const analysis = await analyzeWithEngines(services, chess, selectedRequest(analysis_level, depth, multipv, engine_mode, movetime_ms), signal);
    const payload = positionPayload(game_id, revision, chess, analysis_level, analysis);
    return toolResult(payload, `Analyzed game ${game_id} at revision ${revision} with ${payload.mode}`);
  }));

  server.registerTool("human_move_distribution", {
    ...TOOL_META.human_move_distribution, inputSchema: TOOL_INPUT_SCHEMAS.human_move_distribution, outputSchema: TOOL_OUTPUT_SCHEMAS.human_move_distribution,
  }, safeHandler(TOOL_INPUT_SCHEMAS.human_move_distribution, TOOL_OUTPUT_SCHEMAS.human_move_distribution, async ({ game_id, elo, oppo_elo, top_n }, signal) => {
    const { chess, revision } = services.games.getSnapshot(game_id);
    const legal = legalMoveMap(chess);
    const opponentElo = oppo_elo ?? elo;
    const moves = structuredClone(await services.humanMoveDistribution(snapshotChess(chess), elo, opponentElo, top_n, signal));
    validateHumanMoves(moves, top_n, legal);
    const payload: HumanMoveDistribution = { game_id, elo, oppo_elo: opponentElo, revision, moves };
    return toolResult(payload, `${moves.length} Maia3 moves for game ${game_id} at revision ${revision}`);
  }));

  server.registerTool("move_evaluate", {
    ...TOOL_META.move_evaluate, inputSchema: TOOL_INPUT_SCHEMAS.move_evaluate, outputSchema: TOOL_OUTPUT_SCHEMAS.move_evaluate,
  }, safeHandler(TOOL_INPUT_SCHEMAS.move_evaluate, TOOL_OUTPUT_SCHEMAS.move_evaluate, async ({ game_id, move, depth, engine_mode, movetime_ms }, signal) => {
    const { chess, revision } = services.games.getSnapshot(game_id);
    if (chess.isGameOver()) throw new ChessError("GAME_OVER", "game is already over");
    const moves = Array.isArray(move) ? move : [move];
    const parsedMoves = moves.map((moveValue) => parseMove(chess, moveValue));
    const request: EngineRequest = {
      ...(engine_mode === undefined ? {} : { mode: engine_mode }),
      depth,
      multipv: 1,
      movetimeMs: movetime_ms,
    };
    const before = await analyzeWithEngines(services, chess, request, signal);
    for (const id of ENGINE_IDS) {
      const outcome = before.engines[id];
      if (outcome.status !== "ok") continue;
      for (const line of outcome.result) completePvSan(chess, line.pv);
    }
    const results: MoveEvaluation[] = [];
    for (const parsed of parsedMoves) {
      signal.throwIfAborted();
      const copy = snapshotChess(chess);
      playParsedMove(copy, parsed);
      const terminal = copy.isCheckmate() ? "checkmate" : drawResult(copy);
      if (terminal) {
        const engines = terminalEngineResults(before, terminal);
        const enginesUsed = ENGINE_IDS.filter((id) => engines[id].status === "ok");
        const requested = before.mode === "both" ? ENGINE_IDS : [before.mode];
        results.push({ move: parsed.san, uci: parsed.lan, result: terminal, engines, classificationBasis: enginesUsed.length ? "engine_cp_heuristic" : null, partial: enginesUsed.length < requested.length, enginesUsed });
        continue;
      }
      const after = await analyzeWithEngines(services, copy, request, signal);
      const engines = { stockfish: moveEngineResult(copy, before.engines.stockfish, after.engines.stockfish), lc0: moveEngineResult(copy, before.engines.lc0, after.engines.lc0) };
      const values = Object.values(engines);
      const hasError = values.some((outcome) => outcome.status === "error");
      const hasOk = values.some((outcome) => outcome.status === "ok");
      if (!hasOk && hasError) {
        const error = values.map(analysisError).find((value): value is Error => value !== null);
        throw error ?? new Error("all requested analysis engines failed");
      }
      const moveEnginesUsed = ENGINE_IDS.filter((id) => engines[id].status === "ok");
      results.push({ move: parsed.san, uci: parsed.lan, result: hasError ? "evaluation_error" : "ongoing", engines, classificationBasis: hasOk ? "engine_cp_heuristic" : null, partial: hasError, enginesUsed: moveEnginesUsed });
    }
    const requested = before.mode === "both" ? ENGINE_IDS : [before.mode];
    const enginesUsed = requested.filter((id) => results.every((result) => result.engines[id].status === "ok"));
    const partial = requested.some((id) => !enginesUsed.includes(id));
    const engineMetadata = {
      stockfish: before.engines.stockfish.status === "ok" ? before.engines.stockfish.meta : null,
      lc0: before.engines.lc0.status === "ok" ? before.engines.lc0.meta : null,
    };
    return toolResult({ game_id, revision, mode: before.mode, partial, enginesUsed, engineMetadata, results }, `Evaluated ${results.length} move${results.length === 1 ? "" : "s"} in game ${game_id}`);
  }));
}
