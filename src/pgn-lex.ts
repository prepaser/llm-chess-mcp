export type PgnSpan = {
  start: number;
  end: number;
};

export type PgnDelimitedSpan = PgnSpan & {
  contentStart: number;
  contentEnd: number;
  closed: boolean;
};

export function scanSpan(
  pgn: string,
  start: number,
  matches: (char: string) => boolean,
): PgnSpan {
  let end = start;
  while (end < pgn.length && matches(pgn[end]!)) end++;
  return { start, end };
}

export function lineSpan(pgn: string, start: number): PgnSpan {
  return scanSpan(pgn, start, (char) => char !== "\n" && char !== "\r");
}

export function wordSpan(
  pgn: string,
  start: number,
  delimiters: RegExp,
): PgnSpan {
  return scanSpan(pgn, start, (char) => {
    delimiters.lastIndex = 0;
    return !delimiters.test(char);
  });
}

export function quotedSpan(pgn: string, start: number): PgnDelimitedSpan {
  let end = start + 1;
  let escaped = false;
  while (end < pgn.length) {
    const char = pgn[end++]!;
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') {
      return {
        start,
        end,
        contentStart: start + 1,
        contentEnd: end - 1,
        closed: true,
      };
    }
  }
  return {
    start,
    end,
    contentStart: start + 1,
    contentEnd: end,
    closed: false,
  };
}

export function commentSpan(
  pgn: string,
  start: number,
): PgnDelimitedSpan | undefined {
  if (pgn[start] === ";") {
    const line = lineSpan(pgn, start + 1);
    return {
      start,
      end: line.end,
      contentStart: start + 1,
      contentEnd: line.end,
      closed: true,
    };
  }
  if (pgn[start] !== "{") return undefined;
  const close = pgn.indexOf("}", start + 1);
  return close < 0
    ? {
        start,
        end: pgn.length,
        contentStart: start + 1,
        contentEnd: pgn.length,
        closed: false,
      }
    : {
        start,
        end: close + 1,
        contentStart: start + 1,
        contentEnd: close,
        closed: true,
      };
}
