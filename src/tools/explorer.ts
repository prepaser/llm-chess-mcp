import type { McpServer } from "@modelcontextprotocol/server";
import { ChessError } from "../errors.js";
import type { AppServices } from "../services.js";
import { OpeningExplorerInputSchema } from "../tool-inputs.js";
import { TOOL_META } from "../tool-meta.js";
import { safeHandler, toolResult } from "../tool-result.js";
import { OpeningExplorerOutputSchema } from "../tool-schemas.js";

type ExplorerServices = Pick<
  AppServices,
  "games" | "explorerEnabled" | "openingExplorer"
>;

export function registerExplorerTool(
  server: McpServer,
  services: ExplorerServices,
): void {
  server.registerTool(
    "opening_explorer",
    {
      ...TOOL_META.opening_explorer,
      inputSchema: OpeningExplorerInputSchema,
      outputSchema: OpeningExplorerOutputSchema,
    },
    safeHandler(
      OpeningExplorerInputSchema,
      async ({ game_id, db, speeds, ratings }, signal) => {
        if (!services.explorerEnabled()) {
          throw new ChessError(
            "LICHESS_DISABLED",
            "LICHESS_TOKEN not set; opening explorer is disabled",
          );
        }
        const { chess, revision } = services.games.getSnapshot(game_id);
        const result = await services.openingExplorer(chess, db, speeds, ratings, signal);
        return toolResult(
          { game_id, revision, ...result },
          `Lichess ${db} returned ${result.moves.length} moves for game ${game_id}`,
        );
      },
    ),
  );
}
