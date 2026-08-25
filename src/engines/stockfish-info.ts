import type { SfLine, Wdl } from "../domain.js";

type Score = {
  cp: number | null;
  mate: number | null;
};

export type AnalysisInfo = {
  multipv: number;
  score?: Score;
  wdl?: Wdl;
  pv?: string[];
};

function parseScore(token: string): Score {
  if (token.startsWith("cp")) return { cp: Number(token.slice(2)), mate: null };
  return { cp: null, mate: Number(token.slice(4)) };
}

function parseWdl(line: string): Wdl | undefined {
  const groups = line.match(
    / wdl (?<wins>\d+) (?<draws>\d+) (?<losses>\d+)/,
  )?.groups;
  if (!groups) return;
  return [Number(groups.wins), Number(groups.draws), Number(groups.losses)];
}

export function parseAnalysisInfo(line: string): AnalysisInfo | null {
  if (!line.startsWith("info") || !line.includes(" multipv ")) return null;

  const multipv = line.match(/multipv (?<value>\d+)/)?.groups?.value;
  if (!multipv) return null;

  const scoreToken = line.match(
    / score (?<value>cp -?\d+|mate -?\d+)/,
  )?.groups?.value;
  const wdl = parseWdl(line);
  const pv = line.match(/ pv (?<value>.+)$/)?.groups?.value;
  return {
    multipv: Number(multipv),
    ...(scoreToken ? { score: parseScore(scoreToken) } : {}),
    ...(wdl ? { wdl } : {}),
    ...(pv ? { pv: pv.split(" ") } : {}),
  };
}

export function mergeAnalysisInfo(
  previous: SfLine | undefined,
  info: AnalysisInfo,
): SfLine {
  return {
    multipv: info.multipv,
    scoreCp: info.score ? info.score.cp : (previous?.scoreCp ?? null),
    scoreMate: info.score ? info.score.mate : (previous?.scoreMate ?? null),
    wdl: info.wdl ?? previous?.wdl ?? null,
    pv: info.pv ?? previous?.pv ?? [],
  };
}
