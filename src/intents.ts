import { Chess } from "chess.js";
import type { ExplorerResult } from "./explorer.js";
import { toEval, evalToCp } from "./eval.js";
import type {
  Candidate,
  ExplorerErrorKind,
  LichessMove,
  Maia3Move,
  MoveSensitivity,
  Objective,
  OpeningStats,
  SfLine,
} from "./domain.js";

export { rankByIntent } from "./intent-ranking.js";

function safeDifference(left: number, right: number): number {
  const result = left - right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(
      "derived chess evaluation exceeds the safe integer range",
    );
  }
  return result;
}

function safeSum(values: readonly number[]): number {
  if (!values.every(Number.isSafeInteger)) {
    throw new RangeError("chess count must be a safe integer");
  }
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("derived chess count exceeds the safe integer range");
  }
  return result;
}

export interface LichessOpts {
  db: "lichess" | "masters";
  speeds: string[];
  ratings: number[];
}

function toSan(chess: Chess, uci: string): string {
  const m = chess.moves({ verbose: true }).find((x) => x.lan === uci);
  return m ? m.san : uci;
}

function objectiveFromLine(
  line: SfLine | undefined,
  turn: "w" | "b",
  bestCp: number | null,
): Objective {
  if (!line) {
    return {
      rank: null,
      moverCp: null,
      whiteCp: null,
      cpLoss: null,
      moverMate: null,
      whiteMate: null,
      wdl: null,
    };
  }
  const e = toEval(line);
  const cp = e ? evalToCp(e) : null;
  const whiteCp = cp !== null ? (turn === "w" ? cp : -cp) : null;
  const mate = line.scoreMate;
  const whiteMate = mate !== null ? (turn === "w" ? mate : -mate) : null;
  return {
    rank: line.multipv,
    moverCp: cp,
    whiteCp,
    cpLoss: cp !== null && bestCp !== null ? safeDifference(bestCp, cp) : null,
    moverMate: mate,
    whiteMate,
    wdl: line.wdl,
  };
}

export interface CandidateSet {
  candidates: Candidate[];
  moveSensitivity: MoveSensitivity;
}

export type ComputeCandidates = (
  chess: Chess,
  elo: number,
  sfDepth: number,
  sfMultipv: number,
  maiaTopN: number,
  lichess?: LichessOpts | null,
  signal?: AbortSignal,
) => Promise<CandidateSet>;

export interface CandidateComputationDependencies {
  analyze(
    fen: string,
    depth: number,
    multipv: number,
    signal?: AbortSignal,
  ): Promise<SfLine[]>;
  humanMoveDistribution(
    chess: Chess,
    elo: number,
    opponentElo: number,
    topN: number,
    signal?: AbortSignal,
  ): Promise<Maia3Move[]>;
  explorerEnabled(): boolean;
  openingExplorer(
    chess: Chess,
    db: "lichess" | "masters",
    speeds: readonly string[],
    ratings: readonly number[],
    signal?: AbortSignal,
  ): Promise<ExplorerResult>;
  explorerFailureReason(error: unknown): ExplorerErrorKind;
}

export type LichessCandidateData =
  | {
      status: "available" | "no_data";
      totalGames: number;
      moves: LichessMove[];
    }
  | {
      status: "unavailable";
      reason: ExplorerErrorKind;
      totalGames: null;
      moves: LichessMove[];
    }
  | { status: "disabled"; totalGames: null; moves: LichessMove[] };

export function explorerCandidateData(
  result: ExplorerResult,
): LichessCandidateData {
  for (const move of result.moves) {
    if (move.count !== safeSum([move.white, move.draws, move.black])) {
      throw new RangeError("derived chess move count is inconsistent");
    }
  }
  return {
    status: result.moves.length > 0 ? "available" : "no_data",
    totalGames: safeSum([result.white, result.draws, result.black]),
    moves: result.moves,
  };
}

export function candidateSetFromData(
  chess: Chess,
  elo: number,
  sfLines: SfLine[],
  maiaMoves: Maia3Move[],
  lichessResult: LichessCandidateData,
): CandidateSet {
  if (chess.isGameOver()) {
    return {
      candidates: [],
      moveSensitivity: { level: "low", topMoveSpreadCp: null },
    };
  }
  const turn = chess.turn();
  const maiaByUci = new Map(maiaMoves.map((move) => [move.uci, move.prob]));
  const legalUcis = new Set(
    chess.moves({ verbose: true }).map((move) => move.lan),
  );
  const sfByUci = new Map<
    string,
    { line: SfLine; evaluation: NonNullable<ReturnType<typeof toEval>> }
  >();
  for (const line of sfLines) {
    const uci = line.pv[0];
    const evaluation = toEval(line);
    if (uci !== undefined && legalUcis.has(uci) && evaluation !== null) {
      sfByUci.set(uci, { line, evaluation });
    }
  }
  const lichessByUci = new Map(
    lichessResult.moves.map((move) => [move.uci, move]),
  );

  const normalizedSfLines = [...sfByUci.values()];
  const evals = normalizedSfLines.map(({ evaluation }) => evaluation);
  const bestCp = evals.length
    ? Math.max(...evals.map((value) => evalToCp(value)))
    : null;
  const totalGames = lichessResult.totalGames ?? 0;

  const ucis = new Set([
    ...sfByUci.keys(),
    ...maiaByUci.keys(),
    ...lichessByUci.keys(),
  ]);
  const candidates: Candidate[] = [];
  for (const uci of ucis) {
    const sf = sfByUci.get(uci)?.line;
    const lichess = lichessByUci.get(uci);
    let opening: OpeningStats;
    if (lichess) {
      const stats = {
        games: lichess.count,
        frequency: totalGames > 0 ? lichess.count / totalGames : null,
        white: lichess.white,
        draws: lichess.draws,
        black: lichess.black,
        averageRating: lichess.averageRating,
      };
      opening =
        lichessResult.status === "unavailable"
          ? {
              status: lichessResult.status,
              reason: lichessResult.reason,
              ...stats,
            }
          : { status: lichessResult.status, ...stats };
    } else {
      const empty = {
        games: null,
        frequency: null,
        white: null,
        draws: null,
        black: null,
        averageRating: null,
      };
      opening =
        lichessResult.status === "unavailable"
          ? {
              status: lichessResult.status,
              reason: lichessResult.reason,
              ...empty,
            }
          : { status: lichessResult.status, ...empty };
    }

    candidates.push({
      uci,
      san: toSan(chess, uci),
      objective: objectiveFromLine(sf, turn, bestCp),
      human: {
        maia3Prob: maiaByUci.get(uci) ?? null,
        selfElo: elo,
        opponentElo: elo,
      },
      opening,
    });
  }

  return {
    candidates,
    moveSensitivity: computeMoveSensitivity(
      normalizedSfLines.map(({ line }) => line),
    ),
  };
}

export function createCandidateComputation(
  dependencies: CandidateComputationDependencies,
): ComputeCandidates {
  return async (
    chess,
    elo,
    sfDepth,
    sfMultipv,
    maiaTopN,
    lichess,
    signal,
  ) => {
    signal?.throwIfAborted();
    if (chess.isGameOver()) {
      return {
        candidates: [],
        moveSensitivity: { level: "low", topMoveSpreadCp: null },
      };
    }
    const controller = new AbortController();
    const workSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const fatal = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        workSignal.throwIfAborted();
        return await work();
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    };

    const explorer = async (): Promise<LichessCandidateData> => {
      workSignal.throwIfAborted();
      if (!lichess || !dependencies.explorerEnabled()) {
        return { status: "disabled", totalGames: null, moves: [] };
      }
      try {
        return explorerCandidateData(
          await dependencies.openingExplorer(
            chess,
            lichess.db,
            lichess.speeds,
            lichess.ratings,
            workSignal,
          ),
        );
      } catch (error) {
        workSignal.throwIfAborted();
        return {
          status: "unavailable",
          reason: dependencies.explorerFailureReason(error),
          totalGames: null,
          moves: [],
        };
      }
    };

    const [sfLines, maiaMoves, lichessResult] = await Promise.all([
      fatal(() =>
        dependencies.analyze(chess.fen(), sfDepth, sfMultipv, workSignal),
      ),
      fatal(() =>
        dependencies.humanMoveDistribution(
          chess,
          elo,
          elo,
          maiaTopN,
          workSignal,
        ),
      ),
      fatal(explorer),
    ]);
    return candidateSetFromData(chess, elo, sfLines, maiaMoves, lichessResult);
  };
}

export function computeMoveSensitivity(sfLines: SfLine[]): MoveSensitivity {
  const cps = sfLines
    .map((l) => toEval(l))
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .map((e) => evalToCp(e));
  if (cps.length < 2) {
    return { level: "low", topMoveSpreadCp: null };
  }
  const spread = safeDifference(Math.max(...cps), Math.min(...cps));
  const level = spread >= 200 ? "high" : spread >= 80 ? "medium" : "low";
  return { level, topMoveSpreadCp: spread };
}
