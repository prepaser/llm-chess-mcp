import { MAX_MULTIPV } from "./domain.js";
import type { SfLine } from "./domain.js";

function validScore(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validWdl(value: unknown): boolean {
  return value === null ||
    (Array.isArray(value) &&
      value.length === 3 &&
      value.every(
        (count) =>
          typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count >= 0 &&
          count <= 1_000,
      ) &&
      value[0]! + value[1]! + value[2]! === 1_000);
}

export function validateAnalysisLines(
  lines: readonly SfLine[],
  requestedMultipv: number,
): void {
  if (
    !Number.isSafeInteger(requestedMultipv) ||
    requestedMultipv < 1 ||
    requestedMultipv > MAX_MULTIPV
  ) {
    throw new RangeError("invalid requested analysis multipv");
  }
  if (!Array.isArray(lines) || lines.length > requestedMultipv) {
    throw new RangeError("analysis returned too many lines");
  }

  const ranks = new Set<number>();
  for (const line of lines) {
    if (
      typeof line !== "object" ||
      line === null ||
      Array.isArray(line) ||
      !Number.isSafeInteger(line.multipv) ||
      line.multipv < 1 ||
      line.multipv > requestedMultipv ||
      ranks.has(line.multipv)
    ) {
      throw new RangeError("invalid analysis multipv rank");
    }
    ranks.add(line.multipv);
    if (!validScore(line.scoreCp) || !validScore(line.scoreMate)) {
      throw new RangeError("analysis line has an invalid score");
    }
    if (line.scoreCp !== null && line.scoreMate !== null) {
      throw new RangeError("analysis line has conflicting scores");
    }
    if (!validWdl(line.wdl)) throw new RangeError("analysis line has invalid WDL");
    if (
      !Array.isArray(line.pv) ||
      !line.pv.every(
        (move: unknown) => typeof move === "string" && move.length > 0,
      )
    ) {
      throw new RangeError("analysis line has invalid PV");
    }
  }
}
