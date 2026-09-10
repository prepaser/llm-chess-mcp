import type { McpServer } from "@modelcontextprotocol/server";
import { isDeepStrictEqual } from "node:util";
import type * as z from "zod/v4";
import { ANALYSIS_PRESETS, evalToCp } from "../eval.js";
import { computeWithEngines } from "../engine-services.js";
import { rankEngineCandidates, type EngineCandidateSet, type MultiEngineCandidate } from "../engine-consensus.js";
import { resolveEngineMode } from "../engines/analysis.js";
import type { EngineId, EngineRequest } from "../engines/types.js";
import type { Objective } from "../domain.js";
import type { AppServices } from "../services.js";
import { candidateExplorerFilters, TOOL_INPUT_SCHEMAS } from "../tool-inputs.js";
import { TOOL_META } from "../tool-meta.js";
import { safeHandler, toolResult } from "../tool-result.js";
import { TOOL_OUTPUT_SCHEMAS } from "../tool-schemas.js";
import { legalMoveMap, type LegalMoveMap, validateMoveIdentities } from "./move-boundary.js";

type CandidateServices = Pick<AppServices, "games" | "computeCandidates" | "rankByIntent" | "computeEngineCandidates" | "rankEngineCandidates">;
type CandidateToolInput = z.output<typeof TOOL_INPUT_SCHEMAS.move_candidates>;
type CandidatePayload = EngineCandidateSet & {
  game_id: string; revision: number; fen: string; turn: "w" | "b";
  elo: number; analysis_level: CandidateToolInput["analysis_level"];
};
const IDS = ["stockfish", "lc0"] as const;

function stableCandidate(candidate: MultiEngineCandidate) {
  const { consensusRank: _rank, consensusScore: _score, support: _support, ...data } = candidate;
  return data;
}

function validateRankedCandidates(candidates: MultiEngineCandidate[], source: readonly MultiEngineCandidate[], legal: LegalMoveMap): void {
  validateMoveIdentities(candidates, legal);
  const originals = new Map(source.map((candidate) => [candidate.uci, stableCandidate(candidate)]));
  for (const candidate of candidates) {
    if (!originals.has(candidate.uci) || !isDeepStrictEqual(stableCandidate(candidate), originals.get(candidate.uci))) {
      throw new RangeError("ranked candidates must preserve source data");
    }
  }
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validatePerspective(mover: unknown, white: unknown, turn: "w" | "b"): void {
  if (!nullableNumber(mover) || !nullableNumber(white) ||
      (mover === null ? white !== null : white !== (turn === "w" ? mover : -mover))) {
    throw new RangeError("candidate objective has inconsistent perspective scores");
  }
}

function validateObjective(objective: Objective, multipv: number, turn: "w" | "b"): void {
  if (objective.rank !== null && (!Number.isSafeInteger(objective.rank) || objective.rank < 1 || objective.rank > multipv)) {
    throw new RangeError("candidate objective rank exceeds requested multipv");
  }
  if (!nullableNumber(objective.cpLoss) || (objective.cpLoss !== null && objective.cpLoss < 0)) {
    throw new RangeError("candidate objective has an invalid cp loss");
  }
  validatePerspective(objective.moverCp, objective.whiteCp, turn);
  validatePerspective(objective.moverMate, objective.whiteMate, turn);
  if (objective.moverMate !== null && (!Number.isSafeInteger(objective.moverMate) ||
      objective.moverCp !== evalToCp({ type: "mate", plies: objective.moverMate }))) {
    throw new RangeError("candidate objective has inconsistent mate scores");
  }
  if (objective.rank === null && [objective.moverCp, objective.whiteCp, objective.cpLoss,
    objective.moverMate, objective.whiteMate, objective.wdl].some((value) => value !== null)) {
    throw new RangeError("unevaluated candidate has objective data");
  }
}

function validateCandidates(computed: EngineCandidateSet, multipv: number, elo: number, turn: "w" | "b", legal: LegalMoveMap): void {
  validateMoveIdentities(computed.candidates, legal);
  for (const candidate of computed.candidates) {
    for (const id of IDS) {
      const objective = candidate.objective.byEngine[id];
      if (objective === null) continue;
      if (!computed.enginesUsed.includes(id)) throw new RangeError("unavailable engine has candidate evaluation");
      validateObjective(objective, multipv, turn);
    }
    if (candidate.human.selfElo !== elo || candidate.human.opponentElo !== elo) {
      throw new RangeError("candidate human ratings differ from requested elo");
    }
  }
}

function consensusCandidates(candidates: MultiEngineCandidate[], engines: EngineId[]): MultiEngineCandidate[] {
  const ranked = rankEngineCandidates(candidates, "best", engines);
  const known = new Set(ranked.map((candidate) => candidate.uci));
  return [...ranked, ...candidates.filter((candidate) => !known.has(candidate.uci)).sort((a, b) => a.uci.localeCompare(b.uci))];
}

async function candidatePayload(services: CandidateServices, input: CandidateToolInput, signal: AbortSignal): Promise<{ payload: CandidatePayload; legal: LegalMoveMap }> {
  const { game_id, elo, analysis_level, sf_depth, sf_multipv, maia_top_n, engine_mode, movetime_ms } = input;
  const { chess, revision } = services.games.getSnapshot(game_id);
  const legal = legalMoveMap(chess);
  const preset = ANALYSIS_PRESETS[analysis_level];
  const request: EngineRequest = {
    mode: resolveEngineMode(engine_mode), depth: sf_depth ?? preset.depth, multipv: sf_multipv ?? preset.multipv,
    movetimeMs: movetime_ms ?? ({ fast: 1_000, normal: 3_000, deep: 10_000 } as const)[analysis_level],
  };
  const base = { game_id, revision, fen: chess.fen(), turn: chess.turn(), elo, analysis_level };
  if (chess.isGameOver()) {
    return { legal, payload: {
      ...base, mode: resolveEngineMode(engine_mode), partial: false, enginesUsed: [],
      engines: { stockfish: { status: "not_requested" }, lc0: { status: "not_requested" } },
      moveSensitivity: { stockfish: null, lc0: null }, candidates: [],
    } };
  }
  const computed = await computeWithEngines(services, chess, elo, request, maia_top_n,
    candidateExplorerFilters(input), signal);
  signal.throwIfAborted();
  validateCandidates(computed, request.multipv, elo, chess.turn(), legal);
  return { legal, payload: { ...base, ...computed, candidates: consensusCandidates(computed.candidates, computed.enginesUsed) } };
}

export function registerCandidateTools(server: McpServer, services: CandidateServices): void {
  server.registerTool("move_candidates", {
    ...TOOL_META.move_candidates, inputSchema: TOOL_INPUT_SCHEMAS.move_candidates, outputSchema: TOOL_OUTPUT_SCHEMAS.move_candidates,
  }, safeHandler(TOOL_INPUT_SCHEMAS.move_candidates, TOOL_OUTPUT_SCHEMAS.move_candidates, async (input, signal) => {
    const { payload } = await candidatePayload(services, input, signal);
    return toolResult(payload, `${payload.candidates.length} candidates for game ${payload.game_id} at revision ${payload.revision}`);
  }));

  server.registerTool("move_candidates_by_intent", {
    ...TOOL_META.move_candidates_by_intent, inputSchema: TOOL_INPUT_SCHEMAS.move_candidates_by_intent, outputSchema: TOOL_OUTPUT_SCHEMAS.move_candidates_by_intent,
  }, safeHandler(TOOL_INPUT_SCHEMAS.move_candidates_by_intent, TOOL_OUTPUT_SCHEMAS.move_candidates_by_intent, async ({ intent, ...input }, signal) => {
    const { payload, legal } = await candidatePayload(services, input, signal);
    const source = structuredClone(payload.candidates);
    const candidates = structuredClone(source.length
      ? services.rankEngineCandidates
        ? services.rankEngineCandidates(structuredClone(source), intent, payload.enginesUsed)
        : rankEngineCandidates(structuredClone(source), intent, payload.enginesUsed, services.rankByIntent)
      : []);
    validateRankedCandidates(candidates, source, legal);
    return toolResult({ ...payload, intent, candidates }, `${candidates.length} ${intent} candidates for game ${payload.game_id}`);
  }));
}
