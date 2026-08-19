import type { McpServer } from "@modelcontextprotocol/server";
import { snapshotChess } from "../chess.js";
import { ANALYSIS_PRESETS } from "../eval.js";
import type { AppServices } from "../services.js";
import { TOOL_INPUT_SCHEMAS } from "../tool-inputs.js";
import { TOOL_META } from "../tool-meta.js";
import { safeHandler, toolResult } from "../tool-result.js";
import { TOOL_OUTPUT_SCHEMAS } from "../tool-schemas.js";

export function registerCandidateTools(
  server: McpServer,
  services: AppServices,
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
      async ({
        game_id,
        elo,
        analysis_level,
        sf_depth,
        sf_multipv,
        maia_top_n,
        lichess_db,
        lichess_speeds,
        lichess_ratings,
      }) => {
        const { chess: live, revision } = services.games.getGame(game_id);
        const chess = snapshotChess(live);
        const preset = ANALYSIS_PRESETS[analysis_level];
        const depth = sf_depth ?? preset.depth;
        const multipv = sf_multipv ?? preset.multipv;
        const { candidates, moveSensitivity } =
          await services.computeCandidates(chess, elo, depth, multipv, maia_top_n, {
            db: lichess_db,
            speeds: lichess_speeds,
            ratings: lichess_ratings,
          });

        return toolResult(
          {
            game_id,
            revision,
            fen: chess.fen(),
            turn: chess.turn(),
            elo,
            analysis_level,
            moveSensitivity,
            candidates,
          },
          `${candidates.length} candidates for game ${game_id} at revision ${revision}`,
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
      async ({
        game_id,
        intent,
        elo,
        analysis_level,
        sf_depth,
        sf_multipv,
        maia_top_n,
        lichess_db,
        lichess_speeds,
        lichess_ratings,
      }) => {
        const { chess: live, revision } = services.games.getGame(game_id);
        const chess = snapshotChess(live);
        const preset = ANALYSIS_PRESETS[analysis_level];
        const depth = sf_depth ?? preset.depth;
        const multipv = sf_multipv ?? preset.multipv;
        const { candidates, moveSensitivity } =
          await services.computeCandidates(chess, elo, depth, multipv, maia_top_n, {
            db: lichess_db,
            speeds: lichess_speeds,
            ratings: lichess_ratings,
          });
        const ranked = services.rankByIntent(candidates, intent);

        return toolResult(
          {
            game_id,
            revision,
            fen: chess.fen(),
            turn: chess.turn(),
            intent,
            elo,
            analysis_level,
            moveSensitivity,
            candidates: ranked,
          },
          `${ranked.length} ${intent} candidates for game ${game_id} at revision ${revision}`,
        );
      },
    ),
  );
}
