import type { Chess } from "chess.js";
import { snapshotChess } from "./chess.js";
import { validateHumanMoves } from "./human-boundary.js";
import { validatePositionAnalysisLines } from "./analysis-boundary.js";
import { validateEngineAnalysis } from "./engine-services.js";
import type { Candidate, Maia3Move, MoveSensitivity, SfLine } from "./domain.js";
import { candidateSetFromData, computeMoveSensitivity, explorerCandidateData, type CandidateSet, type LichessCandidateData, type LichessOpts } from "./intents.js";
import type { EngineAnalysis, EngineId, EngineRequest, EngineOutcome } from "./engines/types.js";
import { resolveEngineMode } from "./engines/analysis.js";

export { rankEngineCandidates } from "./intent-ranking.js";

export const ENGINE_NAMES = ["stockfish", "lc0"] as const satisfies readonly EngineId[];
export type EngineName = EngineId;
export type EngineMode = "both" | EngineName;

export type MultiEngineCandidate = Omit<Candidate, "objective"> & {
  objective: { byEngine: Record<EngineName, Candidate["objective"] | null> };
  consensusRank: number | null;
  consensusScore: number;
  support: number;
};
export type EngineMoveSensitivity = Record<EngineName, MoveSensitivity | null>;
export type EngineCandidateSet = EngineAnalysis & {
  candidates: MultiEngineCandidate[];
  moveSensitivity: EngineMoveSensitivity;
};

function analysisOutcome(analysis: EngineAnalysis, engine: EngineName): Extract<EngineOutcome<SfLine[]>, { status: "ok" }> | null {
  const outcome = analysis.engines[engine];
  return outcome.status === "ok" ? outcome : null;
}
function mergeCandidateSets(byEngine: Partial<Record<EngineName, CandidateSet>>): MultiEngineCandidate[] {
  const merged = new Map<string, MultiEngineCandidate>();
  for (const engine of ENGINE_NAMES) {
    const set = byEngine[engine];
    if (!set) continue;
    for (const candidate of set.candidates) {
      const current = merged.get(candidate.uci);
      if (current) {
        if (current.san !== candidate.san) throw new RangeError(`inconsistent SAN for move ${candidate.uci}`);
        if (candidate.objective.rank !== null) {
          current.objective.byEngine[engine] = candidate.objective;
        }
        continue;
      }
      const objectives: Record<EngineName, Candidate["objective"] | null> = { stockfish: null, lc0: null };
      if (candidate.objective.rank !== null) objectives[engine] = candidate.objective;
      merged.set(candidate.uci, {
        uci: candidate.uci, san: candidate.san, objective: { byEngine: objectives },
        human: candidate.human, opening: candidate.opening,
        consensusRank: null, consensusScore: 0, support: 0,
      });
    }
  }
  return [...merged.values()];
}
export function candidateSetFromEngineAnalysis(chess: Chess, elo: number, analysis: EngineAnalysis, maiaMoves: Maia3Move[], opening: LichessCandidateData, multipv: number): EngineCandidateSet {
  const sets: Partial<Record<EngineName, CandidateSet>> = {};
  const sensitivity: EngineMoveSensitivity = { stockfish: null, lc0: null };
  for (const engine of ENGINE_NAMES) {
    const outcome = analysisOutcome(analysis, engine);
    if (!outcome) continue;
    validatePositionAnalysisLines(outcome.result, multipv, chess);
    sets[engine] = candidateSetFromData(chess, elo, outcome.result, maiaMoves, opening, multipv);
    sensitivity[engine] = computeMoveSensitivity(outcome.result);
  }
  return { ...analysis, candidates: mergeCandidateSets(sets), moveSensitivity: sensitivity };
}

export interface EngineCandidateComputationDependencies {
  analyzeEngines(chess: Chess, request: EngineRequest, signal?: AbortSignal): Promise<EngineAnalysis>;
  humanMoveDistribution(chess: Chess, elo: number, opponentElo: number, topN: number, signal?: AbortSignal): Promise<Maia3Move[]>;
  explorerEnabled(): boolean;
  openingExplorer(chess: Chess, db: "lichess" | "masters", speeds: readonly string[], ratings: readonly number[], signal?: AbortSignal): Promise<import("./explorer.js").ExplorerResult>;
  explorerFailureReason(error: unknown): import("./domain.js").ExplorerErrorKind;
}
export type ComputeEngineCandidates = (chess: Chess, elo: number, request: EngineRequest, maiaTopN: number, lichess?: LichessOpts | null, signal?: AbortSignal) => Promise<EngineCandidateSet>;

export function createEngineCandidateComputation(dependencies: EngineCandidateComputationDependencies): ComputeEngineCandidates {
  return async (chess, elo, request, maiaTopN, lichess, signal) => {
    request = { ...request, mode: resolveEngineMode(request.mode) };
    signal?.throwIfAborted();
    if (chess.isGameOver()) throw new Error("cannot analyze a game-over position");
    const position = snapshotChess(chess);
    const controller = new AbortController();
    const workSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const fatal = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        workSignal.throwIfAborted();
        return await work();
      } catch (error) {
        workSignal.throwIfAborted();
        controller.abort(error);
        throw error;
      }
    };
    const explorer = async (): Promise<LichessCandidateData> => {
      if (!lichess || !dependencies.explorerEnabled()) {
        return { status: "disabled", totalGames: null, moves: [] };
      }
      try {
        return explorerCandidateData(structuredClone(await dependencies.openingExplorer(snapshotChess(position), lichess.db, lichess.speeds, lichess.ratings, workSignal)));
      } catch (error) {
        workSignal.throwIfAborted();
        return { status: "unavailable", reason: dependencies.explorerFailureReason(error), totalGames: null, moves: [] };
      }
    };
    const [analysis, human, opening] = await Promise.all([
      fatal(async () => {
        const result = structuredClone(await dependencies.analyzeEngines(snapshotChess(position), { ...request }, workSignal));
        validateEngineAnalysis(result, request, position);
        return result;
      }),
      fatal(async () => {
        const result = structuredClone(await dependencies.humanMoveDistribution(snapshotChess(position), elo, elo, maiaTopN, workSignal));
        validateHumanMoves(
          result,
          maiaTopN,
          new Map(position.moves({ verbose: true }).map((move) => [move.lan, move.san])),
        );
        return result;
      }),
      explorer(),
    ]);
    workSignal.throwIfAborted();
    return candidateSetFromEngineAnalysis(position, elo, analysis, human, opening, request.multipv);
  };
}
