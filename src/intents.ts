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
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new RangeError("chess count must be a non-negative safe integer");
  }
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("derived chess count exceeds the safe integer range");
  }
  return result;
}

function assertLichessMove(move: LichessMove): void {
  if (move.count !== safeSum([move.white, move.draws, move.black])) {
    throw new RangeError("derived chess move count is inconsistent");
  }
  if (
    move.averageRating !== null &&
    (!Number.isSafeInteger(move.averageRating) || move.averageRating < 0)
  ) {
    throw new RangeError(
      "chess average rating must be a non-negative safe integer",
    );
  }
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
  const totals = [result.white, result.draws, result.black] as const;
  let white = 0;
  let draws = 0;
  let black = 0;
  const ucis = new Set<string>();
  for (const move of result.moves) {
    if (ucis.has(move.uci)) {
      throw new RangeError("duplicate chess move");
    }
    ucis.add(move.uci);
    assertLichessMove(move);
    white = safeSum([white, move.white]);
    draws = safeSum([draws, move.draws]);
    black = safeSum([black, move.black]);
  }
  if (white > result.white || draws > result.draws || black > result.black) {
    throw new RangeError("chess move totals exceed explorer totals");
  }
  return {
    status: result.moves.length > 0 ? "available" : "no_data",
    totalGames: safeSum(totals),
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
  const legalUcis = new Set(
    chess.moves({ verbose: true }).map((move) => move.lan),
  );
  const turn = chess.turn();
  const maiaByUci = new Map<string, number>();
  const maiaUcis = new Set<string>();
  for (const move of maiaMoves) {
    if (maiaUcis.has(move.uci)) throw new RangeError("duplicate Maia move");
    maiaUcis.add(move.uci);
    if (!Number.isFinite(move.prob) || move.prob < 0 || move.prob > 1) {
      throw new RangeError("Maia move probability must be between 0 and 1");
    }
    if (!legalUcis.has(move.uci)) continue;
    maiaByUci.set(move.uci, move.prob);
  }
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
  const totalGames = lichessResult.totalGames ?? 0;
  safeSum([totalGames]);
  const lichessByUci = new Map<string, LichessMove>();
  const lichessUcis = new Set<string>();
  for (const move of lichessResult.moves) {
    if (lichessUcis.has(move.uci)) {
      throw new RangeError("duplicate explorer move");
    }
    lichessUcis.add(move.uci);
    assertLichessMove(move);
    if (move.count > totalGames) {
      throw new RangeError("chess move count exceeds explorer total");
    }
    if (!legalUcis.has(move.uci)) continue;
    lichessByUci.set(move.uci, move);
  }

  const normalizedSfLines = [...sfByUci.values()];
  const evals = normalizedSfLines.map(({ evaluation }) => evaluation);
  const bestCp = evals.length
    ? Math.max(...evals.map((value) => evalToCp(value)))
    : null;
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
    workSignal.throwIfAborted();
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
