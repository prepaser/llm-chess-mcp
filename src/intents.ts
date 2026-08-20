import { Chess } from "chess.js";
import { stockfish } from "./engines/stockfish.js";
import { humanMoveDistribution } from "./maia3/inference.js";
import { ExplorerError, openingExplorer, explorerEnabled } from "./explorer.js";
import type { ExplorerErrorKind, ExplorerResult } from "./explorer.js";
import { toEval, evalToCp } from "./eval.js";
import type {
  Candidate,
  Intent,
  LichessMove,
  Maia3Move,
  MoveSensitivity,
  Objective,
  OpeningStats,
  SfLine,
} from "./types.js";

export interface LichessOpts {
  db: "lichess" | "masters";
  speeds: string[];
  ratings: number[];
}

function softmax(values: number[], temperature: number): number[] {
  const scaled = values.map((v) => v / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
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
    cpLoss: cp !== null && bestCp !== null ? bestCp - cp : null,
    moverMate: mate,
    whiteMate,
    wdl: line.wdl,
  };
}

export interface CandidateSet {
  candidates: Candidate[];
  moveSensitivity: MoveSensitivity;
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
  return {
    status: result.moves.length > 0 ? "available" : "no_data",
    totalGames: result.white + result.draws + result.black,
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
      opening = {
        status: lichessResult.status,
        games: lichess.count,
        frequency: totalGames > 0 ? lichess.count / totalGames : null,
        white: lichess.white,
        draws: lichess.draws,
        black: lichess.black,
        averageRating: lichess.averageRating,
      };
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

export async function computeCandidates(
  chess: Chess,
  elo: number,
  sfDepth: number,
  sfMultipv: number,
  maiaTopN: number,
  lichess?: LichessOpts | null,
): Promise<CandidateSet> {
  const [sfLines, maiaMoves, lichessResult] = await Promise.all([
    stockfish.analyze(chess.fen(), sfDepth, sfMultipv),
    humanMoveDistribution(chess, elo, elo, maiaTopN),
    lichess && explorerEnabled()
      ? openingExplorer(chess, lichess.db, lichess.speeds, lichess.ratings)
          .then(explorerCandidateData)
          .catch((e): LichessCandidateData => ({
            status: "unavailable" as const,
            reason: e instanceof ExplorerError ? e.reason : ("upstream" as const),
            totalGames: null,
            moves: [] as LichessMove[],
          }))
      : Promise.resolve<LichessCandidateData>({
          status: "disabled" as const,
          totalGames: null,
          moves: [] as LichessMove[],
        }),
  ]);
  return candidateSetFromData(chess, elo, sfLines, maiaMoves, lichessResult);
}

function winMargin(c: Candidate): number | null {
  const wdl = c.objective.wdl;
  if (!wdl) return null;
  return wdl[0] - wdl[2];
}

export function computeMoveSensitivity(sfLines: SfLine[]): MoveSensitivity {
  const cps = sfLines
    .map((l) => toEval(l))
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .map((e) => evalToCp(e));
  if (cps.length < 2) {
    return { level: "low", topMoveSpreadCp: null };
  }
  const spread = Math.max(...cps) - Math.min(...cps);
  const level = spread >= 200 ? "high" : spread >= 80 ? "medium" : "low";
  return { level, topMoveSpreadCp: spread };
}

export function rankByIntent(
  candidates: Candidate[],
  intent: Intent,
): Candidate[] {
  const withSf = candidates.filter((c) => c.objective.moverCp !== null);
  const bestMargin = withSf.length
    ? Math.max(...withSf.map((c) => winMargin(c) ?? -Infinity))
    : 0;

  const balancedSfProbs =
    intent === "balanced"
      ? softmax(
          candidates.map((candidate) => candidate.objective.moverCp ?? -1000),
          100,
        )
      : [];
  const scored = candidates.map((c, index) => {
    let score: number;
    switch (intent) {
      case "best":
        score = c.objective.moverCp ?? -Infinity;
        break;
      case "strong": {
        const sf = c.objective.moverCp ?? -Infinity;
        const human = c.human.maia3Prob ?? 0;
        score = human > 0 ? sf : -Infinity;
        break;
      }
      case "natural":
        score = c.human.maia3Prob ?? 0;
        break;
      case "balanced": {
        score =
          0.5 * (balancedSfProbs[index] ?? 0) +
          0.5 * (c.human.maia3Prob ?? 0);
        break;
      }
      case "ease_off": {
        const margin = winMargin(c);
        const human = c.human.maia3Prob ?? 0;
        if (margin === null || human === 0) {
          score = -Infinity;
          break;
        }
        const drop = bestMargin - margin;
        const modest = drop >= 15 && drop <= 50 && margin > 0;
        score = modest ? human : -Infinity;
        break;
      }
      case "give_chance": {
        const margin = winMargin(c);
        const human = c.human.maia3Prob ?? 0;
        if (margin === null || human === 0) {
          score = -Infinity;
          break;
        }
        const drop = bestMargin - margin;
        const meaningful = drop >= 50 && drop <= 150;
        score = meaningful ? human : -Infinity;
        break;
      }
    }
    return { c, score };
  });

  const ranked = scored
    .filter((x) => x.score !== -Infinity)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);

  return ranked;
}
