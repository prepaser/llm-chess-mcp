import type { McpServer } from "@modelcontextprotocol/server";
import { isDeepStrictEqual } from "node:util";
import type * as z from "zod/v4";
import { snapshotChess } from "../chess.js";
import { ANALYSIS_PRESETS } from "../eval.js";
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
    sf_multipv ?? preset.multipv,
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
          TOOL_OUTPUT_SCHEMAS.move_candidates,
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
          TOOL_OUTPUT_SCHEMAS.move_candidates_by_intent,
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
