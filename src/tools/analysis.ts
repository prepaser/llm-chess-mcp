import type { McpServer } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import {
  drawResult,
  parseMove,
  playParsedMove,
  snapshotChess,
} from "../chess.js";
import {
  ANALYSIS_PRESETS,
  classifyCpLoss,
  evalToCp,
  negateEval,
  toEval,
} from "../eval.js";
import type { AppServices } from "../services.js";
import { TOOL_INPUT_SCHEMAS } from "../tool-inputs.js";
import { TOOL_META } from "../tool-meta.js";
import { safeHandler, toolResult } from "../tool-result.js";
import { TOOL_OUTPUT_SCHEMAS } from "../tool-schemas.js";

type PositionAnalysis = z.output<
  typeof TOOL_OUTPUT_SCHEMAS.position_analyze
>;
type HumanMoveDistribution = z.output<
  typeof TOOL_OUTPUT_SCHEMAS.human_move_distribution
>;
type MoveEvaluation = z.output<
  typeof TOOL_OUTPUT_SCHEMAS.move_evaluate
>["results"][number];

export function registerAnalysisTools(
  server: McpServer,
  services: AppServices,
): void {
  server.registerTool(
    "position_analyze",
    {
      ...TOOL_META.position_analyze,
      inputSchema: TOOL_INPUT_SCHEMAS.position_analyze,
      outputSchema: TOOL_OUTPUT_SCHEMAS.position_analyze,
    },
    safeHandler(
      TOOL_INPUT_SCHEMAS.position_analyze,
      async ({ game_id, analysis_level, depth, multipv }) => {
        const { chess: live, revision } = services.games.getGame(game_id);
        const chess = snapshotChess(live);
        const preset = ANALYSIS_PRESETS[analysis_level];
        const d = depth ?? preset.depth;
        const mpv = multipv ?? preset.multipv;
        const lines = await services.analyze(chess.fen(), d, mpv);
        const payload: PositionAnalysis = {
          game_id,
          fen: chess.fen(),
          turn: chess.turn(),
          revision,
          analysis_level,
          lines: lines.map((line) => ({
            multipv: line.multipv,
            scoreCp: line.scoreCp,
            scoreMate: line.scoreMate,
            wdl: line.wdl,
            pv: line.pv,
          })),
        };
        return toolResult(
          payload,
          `Analyzed game ${game_id} at revision ${revision}; ${payload.lines.length} lines`,
        );
      },
    ),
  );

  server.registerTool(
    "human_move_distribution",
    {
      ...TOOL_META.human_move_distribution,
      inputSchema: TOOL_INPUT_SCHEMAS.human_move_distribution,
      outputSchema: TOOL_OUTPUT_SCHEMAS.human_move_distribution,
    },
    safeHandler(
      TOOL_INPUT_SCHEMAS.human_move_distribution,
      async ({ game_id, elo, oppo_elo, top_n }) => {
        const { chess: live, revision } = services.games.getGame(game_id);
        const chess = snapshotChess(live);
        const opponentElo = oppo_elo ?? elo;
        const moves = await services.humanMoveDistribution(
          chess,
          elo,
          opponentElo,
          top_n,
        );
        const payload: HumanMoveDistribution = {
          game_id,
          elo,
          oppo_elo: opponentElo,
          revision,
          moves,
        };
        return toolResult(
          payload,
          `${moves.length} Maia3 moves for game ${game_id} at revision ${revision}`,
        );
      },
    ),
  );

  server.registerTool(
    "move_evaluate",
    {
      ...TOOL_META.move_evaluate,
      inputSchema: TOOL_INPUT_SCHEMAS.move_evaluate,
      outputSchema: TOOL_OUTPUT_SCHEMAS.move_evaluate,
    },
    safeHandler(
      TOOL_INPUT_SCHEMAS.move_evaluate,
      async ({ game_id, move, depth }) => {
        const { chess: live, revision } = services.games.getGame(game_id);
        const chess = snapshotChess(live);
        const moves = Array.isArray(move) ? move : [move];
        const beforeLines = await services.analyze(chess.fen(), depth, 1);
        const before = beforeLines[0];
        const beforeEval = before ? toEval(before) : null;
        const beforeCp = beforeEval ? evalToCp(beforeEval) : null;

        const results: MoveEvaluation[] = [];
        for (const moveValue of moves) {
          const parsed = parseMove(chess, moveValue);
          const copy = snapshotChess(chess);
          playParsedMove(copy, parsed);

          if (copy.isCheckmate()) {
            results.push({
              move: parsed.san,
              uci: parsed.lan,
              result: "checkmate",
              scoreCp: null,
              scoreMate: 0,
              bestCp: beforeCp,
              cpLoss: null,
              classification: "best",
              pv: [],
            });
            continue;
          }
          const result = drawResult(copy);
          if (result) {
            results.push({
              move: parsed.san,
              uci: parsed.lan,
              result,
              scoreCp: 0,
              scoreMate: null,
              bestCp: beforeCp,
              cpLoss: null,
              classification: null,
              pv: [],
            });
            continue;
          }

          const afterLines = await services.analyze(copy.fen(), depth, 1);
          const after = afterLines[0];
          const afterEval = after ? toEval(after) : null;
          const moverEval = afterEval ? negateEval(afterEval) : null;
          const afterCp = moverEval ? evalToCp(moverEval) : null;
          const cpLoss =
            afterCp !== null && beforeCp !== null ? beforeCp - afterCp : null;

          results.push({
            move: parsed.san,
            uci: parsed.lan,
            result: "ongoing",
            scoreCp: afterCp,
            scoreMate: moverEval?.type === "mate" ? moverEval.plies : null,
            bestCp: beforeCp,
            cpLoss,
            classification:
              cpLoss !== null
                ? (classifyCpLoss(cpLoss) as MoveEvaluation["classification"])
                : null,
            pv: after?.pv ?? [],
          });
        }

        return toolResult(
          { game_id, revision, results },
          `Evaluated ${results.length} move${results.length === 1 ? "" : "s"} in game ${game_id}`,
        );
      },
    ),
  );
}
