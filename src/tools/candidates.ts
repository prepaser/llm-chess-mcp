import type { McpServer } from "@modelcontextprotocol/server";
import { ANALYSIS_PRESETS } from "../eval.js";
import type { AppServices } from "../services.js";
import { TOOL_INPUT_SCHEMAS } from "../tool-inputs.js";
import { TOOL_META } from "../tool-meta.js";
import { safeHandler, toolResult } from "../tool-result.js";
import { TOOL_OUTPUT_SCHEMAS } from "../tool-schemas.js";
import type { Candidate, MoveSensitivity } from "../types.js";

type CandidateServices = Pick<
  AppServices,
  "games" | "computeCandidates" | "rankByIntent"
>;

type CandidateToolInput = {
  game_id: string;
  elo: number;
  analysis_level: keyof typeof ANALYSIS_PRESETS;
  sf_depth?: number | undefined;
  sf_multipv?: number | undefined;
  maia_top_n: number;
  lichess_db: "lichess" | "masters";
  lichess_speeds: string[];
  lichess_ratings: number[];
};

type CandidatePayload = {
  game_id: string;
  revision: number;
  fen: string;
  turn: "w" | "b";
  elo: number;
  analysis_level: keyof typeof ANALYSIS_PRESETS;
  moveSensitivity: MoveSensitivity;
  candidates: Candidate[];
};

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
): Promise<CandidatePayload> {
  const { chess, revision } = services.games.getSnapshot(game_id);
  const preset = ANALYSIS_PRESETS[analysis_level];
  const { candidates, moveSensitivity } = await services.computeCandidates(
    chess,
    elo,
    sf_depth ?? preset.depth,
    sf_multipv ?? preset.multipv,
    maia_top_n,
    {
      db: lichess_db,
      speeds: lichess_speeds,
      ratings: lichess_ratings,
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    game_id,
    revision,
    fen: chess.fen(),
    turn: chess.turn(),
    elo,
    analysis_level,
    moveSensitivity,
    candidates,
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
      async (input, signal) => {
        const payload = await candidatePayload(services, input, signal);

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
      async ({ intent, ...input }, signal) => {
        const payload = await candidatePayload(services, input, signal);
        const candidates = services.rankByIntent(payload.candidates, intent);

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
