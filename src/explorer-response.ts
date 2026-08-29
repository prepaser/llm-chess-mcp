import { z } from "zod/v4";
import {
  awaitWithAbort,
  ExplorerError,
  explorerError,
  EXPLORER_ATTEMPT_TIMEOUT_MS,
  EXPLORER_MAX_MOVES,
  EXPLORER_MAX_RESPONSE_BYTES,
  EXPLORER_MAX_STRING_LENGTH,
  throwIfAborted,
} from "./explorer-core.js";
import type { ExplorerResult } from "./explorer-core.js";

const countSchema = z.number().int().nonnegative();
const stringSchema = z.string().min(1).max(EXPLORER_MAX_STRING_LENGTH);
const responseSchema = z.object({
  white: countSchema,
  draws: countSchema,
  black: countSchema,
  moves: z.array(
    z.object({
      uci: stringSchema,
      san: stringSchema,
      white: countSchema,
      draws: countSchema,
      black: countSchema,
      averageRating: z.number().int().nonnegative().optional(),
    }),
  ).max(EXPLORER_MAX_MOVES),
  opening: z
    .object({ eco: stringSchema, name: stringSchema })
    .nullable()
    .optional(),
});

export interface ExplorerResponseOptions {
  callerSignal: AbortSignal | undefined;
  cleanupSignal?: AbortSignal;
  db: "lichess" | "masters";
  legalMoves: ReadonlyMap<string, string>;
}

function sumCounts(...counts: number[]): number {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total)) throw explorerError("invalid_response");
  return total;
}

async function cancelInvalidResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cleanupSignal?: AbortSignal,
): Promise<never> {
  const error = explorerError("invalid_response");
  try {
    const cancellation = reader.cancel(error);
    void cancellation.catch(() => {});
    const deadline =
      cleanupSignal ?? AbortSignal.timeout(EXPLORER_ATTEMPT_TIMEOUT_MS);
    await awaitWithAbort(deadline, () => cancellation).catch(() => {});
  } catch {}
  throw error;
}

async function readJson(
  response: Response,
  signal: AbortSignal,
  callerSignal?: AbortSignal,
  cleanupSignal?: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return JSON.parse("");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await awaitWithAbort(signal, () => reader.read());
      if (done) break;
      bytes += value.byteLength;
      if (bytes > EXPLORER_MAX_RESPONSE_BYTES) {
        await cancelInvalidResponse(reader, cleanupSignal);
      }
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        await cancelInvalidResponse(reader, cleanupSignal);
      }
    }
    try {
      text += decoder.decode();
    } catch {
      throw explorerError("invalid_response");
    }
    return JSON.parse(text);
  } catch (cause) {
    if (cause instanceof ExplorerError) {
      throwIfAborted(callerSignal);
      throw cause;
    }
    if (signal.aborted) {
      try {
        const cancellation = reader.cancel(signal.reason);
        void cancellation.catch(() => {});
        if (callerSignal?.aborted) {
          const deadline =
            cleanupSignal ?? AbortSignal.timeout(EXPLORER_ATTEMPT_TIMEOUT_MS);
          await awaitWithAbort(deadline, () => cancellation).catch(() => {});
        }
      } catch {}
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
    if (cause instanceof ExplorerError) throw cause;
    if (signal.aborted || cause instanceof TypeError) {
      throw explorerError(signal.aborted ? "timeout" : "network");
    }
    throw explorerError("invalid_response");
  }

  throwIfAborted(options.callerSignal);
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw explorerError("invalid_response");
  const data = parsed.data;
  sumCounts(data.white, data.draws, data.black);
  const ucis = new Set<string>();
  let white = 0;
  let draws = 0;
  let black = 0;
  for (const move of data.moves) {
    if (ucis.has(move.uci) || options.legalMoves.get(move.uci) !== move.san) {
      throw explorerError("invalid_response");
    }
    if (sumCounts(move.white, move.draws, move.black) === 0) {
      throw explorerError("invalid_response");
    }
    ucis.add(move.uci);
    white = sumCounts(white, move.white);
    draws = sumCounts(draws, move.draws);
    black = sumCounts(black, move.black);
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
      count: sumCounts(move.white, move.draws, move.black),
      averageRating: move.averageRating ?? null,
    })),
    opening: data.opening ?? null,
  };
}
