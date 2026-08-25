import type { McpServer } from "@modelcontextprotocol/server";
import { parseImportedPgn, parseMove, pgnOf, stateOf } from "../chess.js";
import { ChessError } from "../errors.js";
import type { AppServices } from "../services.js";
import { TOOL_INPUT_SCHEMAS } from "../tool-inputs.js";
import { TOOL_META } from "../tool-meta.js";
import { safeHandler, toolResult } from "../tool-result.js";
import { TOOL_OUTPUT_SCHEMAS } from "../tool-schemas.js";

type GameServices = Pick<AppServices, "games">;

export function registerGameTools(server: McpServer, services: GameServices): void {
  server.registerTool(
    "create_game",
    {
      ...TOOL_META.create_game,
      inputSchema: TOOL_INPUT_SCHEMAS.create_game,
      outputSchema: TOOL_OUTPUT_SCHEMAS.create_game,
    },
    safeHandler(
      TOOL_INPUT_SCHEMAS.create_game,
      TOOL_OUTPUT_SCHEMAS.create_game,
      async ({ fen }, signal) => {
        signal.throwIfAborted();
        let id: string;
        try {
          id = services.games.createGame(fen);
        } catch (error) {
          if (error instanceof ChessError) throw error;
          throw new ChessError("INVALID_FEN", "invalid FEN");
        }
        return toolResult(
          TOOL_OUTPUT_SCHEMAS.create_game,
          { game_id: id, revision: 0 },
          `Created game ${id} at revision 0`,
        );
      },
    ),
  );

  server.registerTool(
    "delete_game",
    {
      ...TOOL_META.delete_game,
      inputSchema: TOOL_INPUT_SCHEMAS.delete_game,
      outputSchema: TOOL_OUTPUT_SCHEMAS.delete_game,
    },
    safeHandler(
      TOOL_INPUT_SCHEMAS.delete_game,
      TOOL_OUTPUT_SCHEMAS.delete_game,
      async ({ game_id }, signal) => {
        signal.throwIfAborted();
        const ok = services.games.deleteGame(game_id);
        if (!ok) {
          throw new ChessError("GAME_NOT_FOUND", `game not found: ${game_id}`);
        }
        return toolResult(
          TOOL_OUTPUT_SCHEMAS.delete_game,
          { game_id, deleted: true },
          `Deleted game ${game_id}`,
        );
      },
    ),
  );

  server.registerTool(
    "game_state",
    {
      ...TOOL_META.game_state,
      inputSchema: TOOL_INPUT_SCHEMAS.game_state,
      outputSchema: TOOL_OUTPUT_SCHEMAS.game_state,
    },
    safeHandler(
      TOOL_INPUT_SCHEMAS.game_state,
      TOOL_OUTPUT_SCHEMAS.game_state,
      async ({ game_id, include_ascii }) => {
        const { chess, revision } = services.games.getSnapshot(game_id);
        const state = stateOf(chess, revision);
        return toolResult(
          TOOL_OUTPUT_SCHEMAS.game_state,
          {
            game_id,
            ...state,
            ...(include_ascii ? { board: chess.ascii() } : {}),
          },
          `Game ${game_id} at revision ${revision}; ${state.turn} to move`,
        );
      },
    ),
  );

  server.registerTool(
    "game_play_move",
    {
      ...TOOL_META.game_play_move,
      inputSchema: TOOL_INPUT_SCHEMAS.game_play_move,
      outputSchema: TOOL_OUTPUT_SCHEMAS.game_play_move,
    },
    safeHandler(
      TOOL_INPUT_SCHEMAS.game_play_move,
      TOOL_OUTPUT_SCHEMAS.game_play_move,
      async ({ game_id, move, expected_revision }, signal) => {
        const { chess, revision } = services.games.getSnapshot(game_id);
        if (expected_revision !== revision) {
          throw new ChessError(
            "STALE_POSITION",
            `position changed: expected revision ${expected_revision}, current ${revision}`,
          );
        }
        if (chess.isGameOver()) {
          throw new ChessError("GAME_OVER", "game is already over");
        }
        const parsed = parseMove(chess, move);
        signal.throwIfAborted();
        const { chess: next, revision: newRevision } = services.games.applyMove(
          game_id,
          expected_revision,
          parsed,
        );
        return toolResult(
          TOOL_OUTPUT_SCHEMAS.game_play_move,
          { game_id, move: parsed.san, ...stateOf(next, newRevision) },
          `Played ${parsed.san} in game ${game_id}; revision ${newRevision}`,
        );
      },
    ),
  );

  server.registerTool(
    "game_legal_moves",
    {
      ...TOOL_META.game_legal_moves,
      inputSchema: TOOL_INPUT_SCHEMAS.game_legal_moves,
      outputSchema: TOOL_OUTPUT_SCHEMAS.game_legal_moves,
    },
    safeHandler(
      TOOL_INPUT_SCHEMAS.game_legal_moves,
      TOOL_OUTPUT_SCHEMAS.game_legal_moves,
      async ({ game_id }, signal) => {
        const { chess, revision } = services.games.getSnapshot(game_id);
        if (chess.isGameOver()) {
          return toolResult(
            TOOL_OUTPUT_SCHEMAS.game_legal_moves,
            { game_id, revision, count: 0, moves: [] },
            `Game ${game_id} is over`,
          );
        }
        const moves = [];
        for (const move of chess.moves({ verbose: true })) {
          signal.throwIfAborted();
          moves.push({
            san: move.san,
            uci: move.lan,
            from: move.from,
            to: move.to,
            piece: move.piece,
            captured: move.captured ?? null,
            promotion:
              move.promotion === "n" ||
              move.promotion === "b" ||
              move.promotion === "r" ||
              move.promotion === "q"
                ? move.promotion
                : null,
            isCapture: move.isCapture() || move.isEnPassant(),
            isCheck: move.san.includes("+") || move.san.includes("#"),
          });
        }
        return toolResult(
          TOOL_OUTPUT_SCHEMAS.game_legal_moves,
          { game_id, revision, count: moves.length, moves },
          `${moves.length} legal moves in game ${game_id} at revision ${revision}`,
        );
      },
    ),
  );

  server.registerTool(
    "game_pgn",
    {
      ...TOOL_META.game_pgn,
      inputSchema: TOOL_INPUT_SCHEMAS.game_pgn,
      outputSchema: TOOL_OUTPUT_SCHEMAS.game_pgn,
    },
    safeHandler(
      TOOL_INPUT_SCHEMAS.game_pgn,
      TOOL_OUTPUT_SCHEMAS.game_pgn,
      async ({ game_id }) => {
        const { chess, revision } = services.games.getSnapshot(game_id);
        return toolResult(
          TOOL_OUTPUT_SCHEMAS.game_pgn,
          { game_id, revision, pgn: pgnOf(chess) },
          `Exported PGN for game ${game_id} at revision ${revision}`,
        );
      },
    ),
  );

  server.registerTool(
    "game_import_pgn",
    {
      ...TOOL_META.game_import_pgn,
      inputSchema: TOOL_INPUT_SCHEMAS.game_import_pgn,
      outputSchema: TOOL_OUTPUT_SCHEMAS.game_import_pgn,
    },
    safeHandler(
      TOOL_INPUT_SCHEMAS.game_import_pgn,
      TOOL_OUTPUT_SCHEMAS.game_import_pgn,
      async ({ pgn }, signal) => {
        const chess = parseImportedPgn(pgn);
        signal.throwIfAborted();
        const id = services.games.createGameFromChess(chess);
        return toolResult(
          TOOL_OUTPUT_SCHEMAS.game_import_pgn,
          { game_id: id, ...stateOf(chess, 0) },
          `Imported game ${id} with ${chess.history().length} plies`,
        );
      },
    ),
  );
}
