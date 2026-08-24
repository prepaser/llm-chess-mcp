export const TOOL_NAMES = [
  "create_game",
  "delete_game",
  "game_import_pgn",
  "game_legal_moves",
  "game_pgn",
  "game_play_move",
  "game_state",
  "human_move_distribution",
  "move_candidates",
  "move_candidates_by_intent",
  "move_evaluate",
  "opening_explorer",
  "position_analyze",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
