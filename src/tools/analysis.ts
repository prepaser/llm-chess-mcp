import type { McpServer } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import {
  drawResult,
  parseMove,
  playParsedMove,
  pvToSan,
  snapshotChess,
} from "../chess.js";
import {
  HUMAN_PROBABILITY_TOLERANCE,
  MAX_HUMAN_MOVES,
  type Maia3Move,
} from "../domain.js";
import {
  ANALYSIS_PRESETS,
  classifyCpLoss,
  evalToCp,
  negateEval,
  toEval,
} from "../eval.js";
import { ChessError } from "../errors.js";
import type { AppServices } from "../services.js";
import { TOOL_INPUT_SCHEMAS } from "../tool-inputs.js";
import { TOOL_META } from "../tool-meta.js";
import { safeHandler, toolResult } from "../tool-result.js";
import { TOOL_OUTPUT_SCHEMAS } from "../tool-schemas.js";
import {
  legalMoveMap,
  type LegalMoveMap,
  validateMoveIdentities,
} from "./move-boundary.js";

type PositionAnalysis = z.output<
  typeof TOOL_OUTPUT_SCHEMAS.position_analyze
>;
type HumanMoveDistribution = z.output<
  typeof TOOL_OUTPUT_SCHEMAS.human_move_distribution
>;
type MoveEvaluation = z.output<
  typeof TOOL_OUTPUT_SCHEMAS.move_evaluate
>["results"][number];

type AnalysisServices = Pick<
  AppServices,
  "games" | "analyze" | "humanMoveDistribution"
>;

function completePvSan(
  chess: Parameters<typeof pvToSan>[0],
  pv: readonly string[],
): string[] {
  const san = pvToSan(chess, pv);
  if (san.length !== pv.length) throw new RangeError("invalid analysis PV");
  return san;
}

function validateHumanMoves(
  moves: Maia3Move[],
  topN: number,
  legal: LegalMoveMap,
): void {
  if (moves.length > topN || moves.length > MAX_HUMAN_MOVES) {
    throw new RangeError("human move distribution exceeds top_n");
  }
  validateMoveIdentities(moves, legal);
  let probabilityMass = 0;
  for (const move of moves) {
    if (!Number.isFinite(move.prob) || move.prob < 0 || move.prob > 1) {
      throw new RangeError("invalid human move probability");
    }
    probabilityMass += move.prob;
  }
  if (probabilityMass > 1 + HUMAN_PROBABILITY_TOLERANCE) {
    throw new RangeError("human move probability mass exceeds 1");
  }
}

export function registerAnalysisTools(
  server: McpServer,
  services: AnalysisServices,
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
      TOOL_OUTPUT_SCHEMAS.position_analyze,
      async ({ game_id, analysis_level, depth, multipv }, signal) => {
        const { chess, revision } = services.games.getSnapshot(game_id);
        const preset = ANALYSIS_PRESETS[analysis_level];
        const d = depth ?? preset.depth;
        const mpv = multipv ?? preset.multipv;
        const lines = await services.analyze(chess.fen(), d, mpv, signal);
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
            pvSan: completePvSan(chess, line.pv),
          })),
        };
        return toolResult(
          TOOL_OUTPUT_SCHEMAS.position_analyze,
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
      TOOL_OUTPUT_SCHEMAS.human_move_distribution,
      async ({ game_id, elo, oppo_elo, top_n }, signal) => {
        const { chess, revision } = services.games.getSnapshot(game_id);
        const legal = legalMoveMap(chess);
        const opponentElo = oppo_elo ?? elo;
        const moves = structuredClone(
          await services.humanMoveDistribution(
            snapshotChess(chess),
            elo,
            opponentElo,
            top_n,
            signal,
          ),
        );
        validateHumanMoves(moves, top_n, legal);
        const payload: HumanMoveDistribution = {
          game_id,
          elo,
          oppo_elo: opponentElo,
          revision,
          moves,
        };
        return toolResult(
          TOOL_OUTPUT_SCHEMAS.human_move_distribution,
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
      TOOL_OUTPUT_SCHEMAS.move_evaluate,
      async ({ game_id, move, depth }, signal) => {
        const { chess, revision } = services.games.getSnapshot(game_id);
        if (chess.isGameOver()) {
          throw new ChessError("GAME_OVER", "game is already over");
        }
        const moves = Array.isArray(move) ? move : [move];
        const beforeLines = await services.analyze(chess.fen(), depth, 1, signal);
        signal.throwIfAborted();
        const before = beforeLines[0];
        const beforeEval = before ? toEval(before) : null;
        const beforeCp = beforeEval ? evalToCp(beforeEval) : null;

        const results: MoveEvaluation[] = [];
        for (const moveValue of moves) {
          signal.throwIfAborted();
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
              pvSan: [],
            });
            continue;
          }
          const result = drawResult(copy);
          if (result) {
            const cpLoss = beforeCp;
            results.push({
              move: parsed.san,
              uci: parsed.lan,
              result,
              scoreCp: 0,
              scoreMate: null,
              bestCp: beforeCp,
              cpLoss,
              classification: cpLoss !== null ? classifyCpLoss(cpLoss) : null,
              pv: [],
              pvSan: [],
            });
            continue;
          }

          const afterLines = await services.analyze(copy.fen(), depth, 1, signal);
          signal.throwIfAborted();
          const after = afterLines[0];
          const afterEval = after ? toEval(after) : null;
          const moverEval = afterEval ? negateEval(afterEval) : null;
          const afterCp = moverEval ? evalToCp(moverEval) : null;
          const cpLoss =
            afterCp !== null && beforeCp !== null ? beforeCp - afterCp : null;

          const pv = after?.pv ?? [];
          results.push({
            move: parsed.san,
            uci: parsed.lan,
            result: "ongoing",
            scoreCp: afterCp,
            scoreMate: moverEval?.type === "mate" ? moverEval.plies : null,
            bestCp: beforeCp,
            cpLoss,
            classification: cpLoss !== null ? classifyCpLoss(cpLoss) : null,
            pv,
            pvSan: completePvSan(copy, pv),
          });
        }

        return toolResult(
          TOOL_OUTPUT_SCHEMAS.move_evaluate,
          { game_id, revision, results },
          `Evaluated ${results.length} move${results.length === 1 ? "" : "s"} in game ${game_id}`,
        );
      },
    ),
  );
}
