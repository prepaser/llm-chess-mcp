import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { ToolName } from "./tool-names.js";

type ToolMeta = {
  title: string;
  description: string;
  annotations: ToolAnnotations;
};

const readOnly = (openWorldHint = false): ToolAnnotations => ({
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint,
});

export const TOOL_META = {
  create_game: {
    title: "Create Chess Game",
    description:
      "Create a new chess game and return its game_id. The server is the authoritative source of board state — never track the board yourself. Optionally pass a FEN to start from a custom position.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  delete_game: {
    title: "Delete Chess Game",
    description: "Delete a process-shared game and free game capacity.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  game_state: {
    title: "Get Chess Game State",
    description:
      "Return the authoritative state of a game: FEN, turn, revision, check/mate/draw flags, move history, last move, castling rights. Use this instead of remembering the board. Set include_ascii=true to also get a board diagram.",
    annotations: readOnly(),
  },
  game_play_move: {
    title: "Play Chess Move",
    description:
      "Play a move (SAN like 'e4' or UCI like 'e2e4') and return the resulting state. This is the ONLY tool that mutates the game. expected_revision is required: pass the revision from your most recent game_state/move_candidates read. If the game has advanced since then, the move is rejected with STALE_POSITION.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  game_legal_moves: {
    title: "List Legal Chess Moves",
    description:
      "List all legal moves in the current position (SAN, UCI, piece, capture, promotion).",
    annotations: readOnly(),
  },
  position_analyze: {
    title: "Analyze Chess Position",
    description:
      "Run Stockfish on the current position and return the top engine lines (multipv) as UCI pv and SAN pvSan. Scores are from the side-to-move perspective: positive cp = side to move is better; mate N = side to move mates in N. wdl is [win, draw, loss] in permille for the side to move. Use analysis_level (fast/normal/deep) or explicit depth/multipv. Does NOT mutate the game.",
    annotations: readOnly(),
  },
  human_move_distribution: {
    title: "Estimate Human Chess Moves",
    description:
      "Return the Maia3 human-like move probability distribution for the current position, conditioned on a target Elo. Higher probability = more human-typical at that rating. This is NOT move quality — a high-probability move can still be objectively bad.",
    annotations: readOnly(),
  },
  move_evaluate: {
    title: "Evaluate Chess Moves",
    description:
      "Evaluate one or more moves with Stockfish without mutating the game. Pass a single move string or an array of moves to compare. Returns, for each move, the score after the move (from the mover's perspective), cpLoss vs the best move, a classification (best/excellent/good/inaccuracy/mistake/blunder), and the continuation as UCI pv and SAN pvSan.",
    annotations: readOnly(),
  },
  move_candidates: {
    title: "Generate Chess Move Candidates",
    description:
      "The primary move-selection tool. Combine Stockfish objective evaluation (moverCp, whiteCp, cpLoss, mate, WDL), Maia3 human probability, and Lichess real-game statistics into a unified candidate list. moverCp is from the mover's perspective: higher = better for the player choosing the move. Use this before choosing a move; the final choice is yours.",
    annotations: readOnly(true),
  },
  move_candidates_by_intent: {
    title: "Rank Chess Moves by Intent",
    description:
      "Convenience layer over move_candidates: rank candidates for a strategic intent. This tool RANKS candidates but does NOT choose a move — use the returned signals and conversation context to make the final decision. Do not map user skill mechanically to an intent. intents: best (strongest engine move), strong (engine-strong but human-plausible), natural (most human-typical), balanced (blend of strength and human-likeness), ease_off (human-plausible moves that modestly reduce advantage without changing the expected result), give_chance (human-plausible inaccuracies that meaningfully improve the opponent's chances).",
    annotations: readOnly(true),
  },
  opening_explorer: {
    title: "Query Lichess Opening Explorer",
    description:
      "Query the Lichess opening explorer for real human game statistics in the current position (requires LICHESS_TOKEN).",
    annotations: readOnly(true),
  },
  game_pgn: {
    title: "Export Chess PGN",
    description: "Export the current game as PGN.",
    annotations: readOnly(),
  },
  game_import_pgn: {
    title: "Import Chess PGN",
    description:
      "Import a PGN into a new game. Returns a new game_id with the position after all PGN moves. Rejects malformed or illegal PGN.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
} as const satisfies Record<ToolName, ToolMeta>;
