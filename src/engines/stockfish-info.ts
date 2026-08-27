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

const MAX_MULTIPV = 256;
const MAX_SCORE = 100_000;
const MAX_WDL = 1_000;

function parseInteger(
  value: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

function parseScore(token: string): Score | undefined {
  const value = parseInteger(
    token.slice(token.startsWith("cp") ? 2 : 4),
    -MAX_SCORE,
    MAX_SCORE,
  );
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
  const wins = parseInteger(winToken, 0, MAX_WDL);
  const draws = parseInteger(drawToken, 0, MAX_WDL);
  const losses = parseInteger(lossToken, 0, MAX_WDL);
  if (wins === undefined || draws === undefined || losses === undefined) return;
  if (wins + draws + losses !== MAX_WDL) return;
  return [wins, draws, losses];
}

export function parseAnalysisInfo(line: string): AnalysisInfo | null {
  if (line !== "info" && !line.startsWith("info ")) return null;

  const multipvToken = line.match(
    /multipv (?<value>\d+)(?=\s|$)/,
  )?.groups?.value;
  if (!multipvToken && line.includes(" multipv ")) return null;
  const terminal =
    line.includes(" depth 0 ") &&
    / score (?:cp|mate) -?0(?=\s|$)/.test(line);
  if (!multipvToken && !terminal) return null;
  const multipv = multipvToken
    ? parseInteger(multipvToken, 1, MAX_MULTIPV)
    : 1;
  if (multipv === undefined) return null;

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
