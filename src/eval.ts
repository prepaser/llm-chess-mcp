import type { SfLine } from "./types.js";

export type Eval =
  | { type: "cp"; value: number }
  | { type: "mate"; plies: number };

export function toEval(line: SfLine): Eval | null {
  if (line.scoreMate !== null) {
    return { type: "mate", plies: line.scoreMate };
  }
  if (line.scoreCp !== null) {
    return { type: "cp", value: line.scoreCp };
  }
  return null;
}

export function evalToCp(e: Eval): number {
  if (e.type === "cp") return e.value;
  const sign = e.plies >= 0 ? 1 : -1;
  return sign * (10000 - Math.abs(e.plies) * 100);
}

export function negateEval(e: Eval): Eval {
  if (e.type === "cp") return { type: "cp", value: -e.value };
  return { type: "mate", plies: -e.plies };
}

export const CLASSIFICATION = {
  best: 0,
  excellent: 30,
  good: 80,
  inaccuracy: 150,
  mistake: 300,
} as const;

export function classifyCpLoss(cpLoss: number): string {
  if (cpLoss <= CLASSIFICATION.best) return "best";
  if (cpLoss < CLASSIFICATION.excellent) return "excellent";
  if (cpLoss < CLASSIFICATION.good) return "good";
  if (cpLoss < CLASSIFICATION.inaccuracy) return "inaccuracy";
  if (cpLoss < CLASSIFICATION.mistake) return "mistake";
  return "blunder";
}

export type AnalysisLevel = "fast" | "normal" | "deep";

export const ANALYSIS_PRESETS: Record<
  AnalysisLevel,
  { depth: number; multipv: number }
> = {
  fast: { depth: 8, multipv: 5 },
  normal: { depth: 15, multipv: 8 },
  deep: { depth: 22, multipv: 10 },
};
