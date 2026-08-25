import { z } from "zod/v4";
import {
  awaitWithAbort,
  explorerError,
  EXPLORER_ATTEMPT_TIMEOUT_MS,
  throwIfAborted,
} from "./explorer-core.js";
import type { ExplorerResult } from "./explorer-core.js";

const countSchema = z.number().int().nonnegative();
const responseSchema = z.object({
  white: countSchema,
  draws: countSchema,
  black: countSchema,
  moves: z.array(
    z.object({
      uci: z.string().min(1),
      san: z.string().min(1),
      white: countSchema,
      draws: countSchema,
      black: countSchema,
      averageRating: z.number().int().nonnegative().optional(),
    }),
  ),
  opening: z
    .object({ eco: z.string().min(1), name: z.string().min(1) })
    .nullable()
    .optional(),
});

export interface ExplorerResponseOptions {
  callerSignal: AbortSignal | undefined;
  cleanupSignal?: AbortSignal;
  db: "lichess" | "masters";
  legalMoves: ReadonlyMap<string, string>;
}

async function readJson(
  response: Response,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
  cleanupSignal?: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return JSON.parse("");

  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await awaitWithAbort(signal, () => reader.read());
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (cause) {
    if (signal.aborted) {
      const cancellation = reader.cancel(signal.reason);
      if (callerSignal?.aborted) {
        const deadline =
          cleanupSignal ?? AbortSignal.timeout(EXPLORER_ATTEMPT_TIMEOUT_MS);
        await awaitWithAbort(deadline, () => cancellation).catch(() => {});
      } else {
        void cancellation.catch(() => {});
      }
      signal.throwIfAborted();
    }
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

export async function normalizeExplorerResponse(
  response: Response,
  signal: AbortSignal,
  options: ExplorerResponseOptions,
): Promise<ExplorerResult> {
  let body: unknown;
  try {
    body = await readJson(
      response,
      signal,
      options.callerSignal,
      options.cleanupSignal,
    );
  } catch (cause) {
    throwIfAborted(options.callerSignal);
    if (signal.aborted || cause instanceof TypeError) {
      throw explorerError(signal.aborted ? "timeout" : "network");
    }
    throw explorerError("invalid_response");
  }

  throwIfAborted(options.callerSignal);
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw explorerError("invalid_response");
  const data = parsed.data;
  const ucis = new Set<string>();
  let white = 0;
  let draws = 0;
  let black = 0;
  for (const move of data.moves) {
    if (ucis.has(move.uci) || options.legalMoves.get(move.uci) !== move.san) {
      throw explorerError("invalid_response");
    }
    ucis.add(move.uci);
    white += move.white;
    draws += move.draws;
    black += move.black;
  }
  if (white > data.white || draws > data.draws || black > data.black) {
    throw explorerError("invalid_response");
  }
  return {
    db: options.db,
    white: data.white,
    draws: data.draws,
    black: data.black,
    moves: data.moves.map((move) => ({
      uci: move.uci,
      san: move.san,
      white: move.white,
      draws: move.draws,
      black: move.black,
      count: move.white + move.draws + move.black,
      averageRating: move.averageRating ?? null,
    })),
    opening: data.opening ?? null,
  };
}
