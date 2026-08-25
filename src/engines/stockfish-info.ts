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

function parseInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseScore(token: string): Score | undefined {
  const value = parseInteger(token.slice(token.startsWith("cp") ? 2 : 4));
  if (value === undefined) return;
  return token.startsWith("cp")
    ? { cp: value, mate: null }
    : { cp: null, mate: value };
}

function parseWdl(line: string): Wdl | undefined {
  const groups = line.match(
    / wdl (?<wins>\d+) (?<draws>\d+) (?<losses>\d+)(?=\s|$)/,
  )?.groups;
  if (!groups) return;
  const { wins: winToken, draws: drawToken, losses: lossToken } = groups;
  if (!winToken || !drawToken || !lossToken) return;
  const wins = parseInteger(winToken);
  const draws = parseInteger(drawToken);
  const losses = parseInteger(lossToken);
  if (wins === undefined || draws === undefined || losses === undefined) return;
  return [wins, draws, losses];
}

export function parseAnalysisInfo(line: string): AnalysisInfo | null {
  if (!line.startsWith("info") || !line.includes(" multipv ")) return null;

  const multipvToken = line.match(
    /multipv (?<value>\d+)(?=\s|$)/,
  )?.groups?.value;
  if (!multipvToken) return null;
  const multipv = parseInteger(multipvToken);
  if (multipv === undefined || multipv < 1) return null;

  const scoreToken = line.match(
    / score (?<value>cp -?\d+|mate -?\d+)(?=\s|$)/,
  )?.groups?.value;
  const score = scoreToken ? parseScore(scoreToken) : undefined;
  const wdl = parseWdl(line);
  const pv = line.match(/ pv (?<value>.+)$/)?.groups?.value;
  return {
    multipv,
    ...(score ? { score } : {}),
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
