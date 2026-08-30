import type { McpServer } from "@modelcontextprotocol/server";
import { isDeepStrictEqual } from "node:util";
import type * as z from "zod/v4";
import { snapshotChess } from "../chess.js";
import { ANALYSIS_PRESETS, evalToCp } from "../eval.js";
import { emptyCandidateSet } from "../intents.js";
import type { Candidate } from "../domain.js";
import type { AppServices } from "../services.js";
import {
  candidateExplorerFilters,
  TOOL_INPUT_SCHEMAS,
} from "../tool-inputs.js";
import { TOOL_META } from "../tool-meta.js";
import { safeHandler, toolResult } from "../tool-result.js";
import { TOOL_OUTPUT_SCHEMAS } from "../tool-schemas.js";
import {
  legalMoveMap,
  type LegalMoveMap,
  validateMoveIdentities,
} from "./move-boundary.js";

type CandidateServices = Pick<
  AppServices,
  "games" | "computeCandidates" | "rankByIntent"
>;

type CandidateToolInput = z.output<
  typeof TOOL_INPUT_SCHEMAS.move_candidates
>;

type CandidatePayload = Omit<
  z.output<typeof TOOL_OUTPUT_SCHEMAS.move_candidates>,
  "candidates"
> & { candidates: Candidate[] };

type CandidateResult = {
  payload: CandidatePayload;
  legal: LegalMoveMap;
};

function validateRankedCandidates(
  candidates: Candidate[],
  source: readonly Candidate[],
  legal: LegalMoveMap,
): void {
  validateMoveIdentities(candidates, legal);
  const sourceByUci = new Map(source.map((candidate) => [candidate.uci, candidate]));
  for (const candidate of candidates) {
    const original = sourceByUci.get(candidate.uci);
    if (!original || !isDeepStrictEqual(candidate, original)) {
      throw new RangeError("ranked candidates must be an unchanged subset");
    }
  }
}

function validNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validatePerspective(
  mover: unknown,
  white: unknown,
  turn: "w" | "b",
): void {
  if (!validNullableNumber(mover) || !validNullableNumber(white)) {
    throw new RangeError("candidate objective has an invalid score");
  }
  if (mover === null || white === null) {
    if (mover !== white) {
      throw new RangeError("candidate objective has incomplete perspective scores");
    }
    return;
  }
  if (white !== (turn === "w" ? mover : -mover)) {
    throw new RangeError("candidate objective has inconsistent perspective scores");
  }
}

function validateCandidateInvariants(
  candidates: readonly Candidate[],
  sfMultipv: number,
  elo: number,
  turn: "w" | "b",
): void {
  for (const candidate of candidates) {
    const { objective, human } = candidate;
    if (
      objective.rank !== null &&
      (!Number.isSafeInteger(objective.rank) ||
        objective.rank < 1 ||
        objective.rank > sfMultipv)
    ) {
      throw new RangeError("candidate objective rank exceeds requested multipv");
    }
    if (
      !validNullableNumber(objective.cpLoss) ||
      (objective.cpLoss !== null && objective.cpLoss < 0)
    ) {
      throw new RangeError("candidate objective has an invalid cp loss");
    }
    validatePerspective(objective.moverCp, objective.whiteCp, turn);
    validatePerspective(objective.moverMate, objective.whiteMate, turn);
    if (
      objective.moverMate !== null &&
      (!Number.isSafeInteger(objective.moverMate) ||
        objective.moverCp !== evalToCp({
          type: "mate",
          plies: objective.moverMate,
        }))
    ) {
      throw new RangeError("candidate objective has inconsistent mate scores");
    }
    if (
      objective.rank === null &&
      [
        objective.moverCp,
        objective.whiteCp,
        objective.cpLoss,
        objective.moverMate,
        objective.whiteMate,
        objective.wdl,
      ].some((value) => value !== null)
    ) {
      throw new RangeError("unevaluated candidate has objective data");
    }
    if (human.selfElo !== elo || human.opponentElo !== elo) {
      throw new RangeError("candidate human ratings differ from requested elo");
    }
  }
}

async function candidatePayload(
  services: CandidateServices,
  {
    game_id,
    elo,
    analysis_level,
    sf_depth,
    sf_multipv,
    maia_top_n,
    lichess_db,
    lichess_speeds,
    lichess_ratings,
  }: CandidateToolInput,
  signal: AbortSignal,
): Promise<CandidateResult> {
  const { chess, revision } = services.games.getSnapshot(game_id);
  const fen = chess.fen();
  const turn = chess.turn();
  const legal = legalMoveMap(chess);
  const preset = ANALYSIS_PRESETS[analysis_level];
  const resolvedSfMultipv = sf_multipv ?? preset.multipv;
  if (chess.isGameOver()) {
    return {
      legal,
      payload: {
        game_id,
        revision,
        fen,
        turn,
        elo,
        analysis_level,
        ...emptyCandidateSet(),
      },
    };
  }
  const computed = await services.computeCandidates(
    snapshotChess(chess),
    elo,
    sf_depth ?? preset.depth,
    resolvedSfMultipv,
    maia_top_n,
    candidateExplorerFilters({
      lichess_db,
      lichess_speeds,
      lichess_ratings,
    }),
    signal,
  );
  signal.throwIfAborted();
  const { candidates, moveSensitivity } = structuredClone(computed);
  validateMoveIdentities(candidates, legal);
  validateCandidateInvariants(candidates, resolvedSfMultipv, elo, turn);

  return {
    legal,
    payload: {
      game_id,
      revision,
      fen,
      turn,
      elo,
      analysis_level,
      moveSensitivity,
      candidates,
    },
  };
}

export function registerCandidateTools(
  server: McpServer,
  services: CandidateServices,
): void {
  const moveCandidatesSchema = TOOL_INPUT_SCHEMAS.move_candidates;
  server.registerTool(
    "move_candidates",
    {
      ...TOOL_META.move_candidates,
      inputSchema: moveCandidatesSchema,
      outputSchema: TOOL_OUTPUT_SCHEMAS.move_candidates,
    },
    safeHandler(
      moveCandidatesSchema,
      TOOL_OUTPUT_SCHEMAS.move_candidates,
      async (input, signal) => {
        const { payload } = await candidatePayload(services, input, signal);

        return toolResult(
          payload,
          `${payload.candidates.length} candidates for game ${payload.game_id} at revision ${payload.revision}`,
        );
      },
    ),
  );

  const byIntentSchema = TOOL_INPUT_SCHEMAS.move_candidates_by_intent;
  server.registerTool(
    "move_candidates_by_intent",
    {
      ...TOOL_META.move_candidates_by_intent,
      inputSchema: byIntentSchema,
      outputSchema: TOOL_OUTPUT_SCHEMAS.move_candidates_by_intent,
    },
    safeHandler(
      byIntentSchema,
      TOOL_OUTPUT_SCHEMAS.move_candidates_by_intent,
      async ({ intent, ...input }, signal) => {
        const { payload, legal } = await candidatePayload(services, input, signal);
        const source = structuredClone(payload.candidates);
        const candidates = structuredClone(
          source.length
            ? services.rankByIntent(structuredClone(source), intent)
            : [],
        );
        validateRankedCandidates(candidates, source, legal);

        return toolResult(
          {
            ...payload,
            intent,
            candidates,
          },
          `${candidates.length} ${intent} candidates for game ${payload.game_id} at revision ${payload.revision}`,
        );
      },
    ),
  );
}
