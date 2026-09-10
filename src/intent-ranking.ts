import type { Candidate, Intent } from "./types.js";
import type { EngineName, MultiEngineCandidate } from "./engine-consensus.js";
import { isDeepStrictEqual } from "node:util";

function softmax(values: number[], temperature: number): number[] {
  const scaled = values.map((value) => value / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
  const sum = exps.reduce((left, right) => left + right, 0);
  return exps.map((value) => value / sum);
}

function winMargin(candidate: Candidate): number | null {
  const wdl = candidate.objective.wdl;
  return wdl ? wdl[0] - wdl[2] : null;
}

export function rankByIntent(
  candidates: Candidate[],
  intent: Intent,
): Candidate[] {
  const withSf = candidates.filter(
    (candidate) => candidate.objective.moverCp !== null,
  );
  const bestMargin = withSf.length
    ? Math.max(...withSf.map((candidate) => winMargin(candidate) ?? -Infinity))
    : 0;

  const balancedSfProbs = new Map<Candidate, number>();
  if (intent === "balanced" && withSf.length > 0) {
    const probabilities = softmax(
      withSf.map((candidate) => candidate.objective.moverCp ?? 0),
      100,
    );
    for (const [index, candidate] of withSf.entries()) {
      balancedSfProbs.set(candidate, probabilities[index] ?? 0);
    }
  }

  return candidates
    .map((candidate) => {
      let score: number;
      switch (intent) {
        case "best":
          score = candidate.objective.moverCp ?? -Infinity;
          break;
        case "strong": {
          const sf = candidate.objective.moverCp ?? -Infinity;
          score = (candidate.human.maia3Prob ?? 0) > 0 ? sf : -Infinity;
          break;
        }
        case "natural":
          score = candidate.human.maia3Prob ?? -Infinity;
          break;
        case "balanced":
          score =
            0.5 * (balancedSfProbs.get(candidate) ?? 0) +
            0.5 * (candidate.human.maia3Prob ?? 0);
          break;
        case "ease_off": {
          const margin = winMargin(candidate);
          const human = candidate.human.maia3Prob ?? 0;
          if (margin === null || human === 0) {
            score = -Infinity;
            break;
          }
          const drop = bestMargin - margin;
          score = drop >= 15 && drop <= 50 && margin > 0 ? human : -Infinity;
          break;
        }
        case "give_chance": {
          const margin = winMargin(candidate);
          const human = candidate.human.maia3Prob ?? 0;
          if (margin === null || human === 0) {
            score = -Infinity;
            break;
          }
          const drop = bestMargin - margin;
          score = drop >= 50 && drop <= 150 ? human : -Infinity;
          break;
        }
      }
      return { candidate, score };
    })
    .filter(({ score }) => score !== -Infinity)
    .sort((left, right) => right.score - left.score)
    .map(({ candidate }) => candidate);
}

function emptyObjective(): Candidate["objective"] {
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

function singleEngineCandidate(
  candidate: MultiEngineCandidate,
  engine: EngineName,
): Candidate {
  return {
    ...candidate,
    objective: candidate.objective.byEngine[engine] ?? emptyObjective(),
  };
}

function naturalRank(
  candidates: readonly MultiEngineCandidate[],
): MultiEngineCandidate[] {
  return [...candidates]
    .filter((candidate) => candidate.human.maia3Prob !== null)
    .sort(
      (left, right) =>
        (right.human.maia3Prob ?? 0) - (left.human.maia3Prob ?? 0) ||
        left.uci.localeCompare(right.uci),
    );
}

export function rankEngineCandidates(
  candidates: readonly MultiEngineCandidate[],
  intent: Intent,
  engines: readonly EngineName[],
  perEngineRanker: (candidates: Candidate[], intent: Intent) => Candidate[] = rankByIntent,
): MultiEngineCandidate[] {
  if (intent === "natural") return naturalRank(candidates);
  const successful = [...new Set(engines)];
  if (successful.length === 0) return [];
  const ranks = new Map<string, { score: number; support: number }>();
  for (const engine of successful) {
    const source = candidates
      .filter((candidate) => candidate.objective.byEngine[engine]?.rank != null)
      .map((candidate) => singleEngineCandidate(candidate, engine));
    const ranked = perEngineRanker(
      structuredClone(source),
      intent,
    );
    const sourceByUci = new Map(source.map((candidate) => [candidate.uci, candidate]));
    const seen = new Set<string>();
    for (const candidate of ranked) {
      const original = sourceByUci.get(candidate.uci);
      if (!original || seen.has(candidate.uci) || !isDeepStrictEqual(candidate, original)) {
        throw new RangeError("engine-ranked candidates must be an unchanged subset");
      }
      seen.add(candidate.uci);
    }
    ranked.forEach((candidate, index) => {
      const current = ranks.get(candidate.uci) ?? { score: 0, support: 0 };
      current.score += 1 / (60 + index + 1);
      current.support += 1;
      ranks.set(candidate.uci, current);
    });
  }
  const allEnginesRequired = intent === "ease_off" || intent === "give_chance";
  return [...candidates]
    .filter((candidate) => {
      const rank = ranks.get(candidate.uci);
      return (
        rank !== undefined &&
        (!allEnginesRequired || rank.support === successful.length)
      );
    })
    .map((candidate) => {
      const rank = ranks.get(candidate.uci)!;
      return { candidate, score: rank.score / successful.length, support: rank.support };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.support - left.support ||
        left.candidate.uci.localeCompare(right.candidate.uci),
    )
    .map(({ candidate, score, support }, index) => ({
      ...candidate,
      consensusRank: index + 1,
      consensusScore: score,
      support,
    }));
}
