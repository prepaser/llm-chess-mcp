import type { Candidate, Intent } from "./types.js";

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
