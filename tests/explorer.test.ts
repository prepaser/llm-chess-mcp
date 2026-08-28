import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chess.js";
import {
  EXPLORER_ATTEMPT_TIMEOUT_MS,
  EXPLORER_DEFAULT_RETRY_DELAY_MS,
  EXPLORER_MAX_COOLDOWN_MS,
  EXPLORER_MAX_MOVES,
  EXPLORER_MAX_RESPONSE_BYTES,
  EXPLORER_MAX_STRING_LENGTH,
  EXPLORER_RATE_LIMIT_COOLDOWN_MS,
  EXPLORER_TOTAL_TIMEOUT_MS,
  ExplorerError,
  LICHESS_RATINGS,
  LICHESS_SPEEDS,
  createExplorerLimiter,
  openingExplorer,
  type ExplorerFetch,
  type ExplorerLimiter,
  type ExplorerRequestOptions,
} from "../src/explorer.js";
import { rateLimitCooldownMs } from "../src/explorer-retry.js";

const validBody = {
  white: 10,
  draws: 5,
  black: 7,
  moves: [
    {
      uci: "e2e4",
      san: "e4",
      white: 4,
      draws: 2,
      black: 3,
      averageRating: 1812,
    },
  ],
  opening: { eco: "B00", name: "King's Pawn Game" },
};

function response(
  status = 200,
  body: unknown = validBody,
  headers?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify(body),
    headers ? { status, headers } : { status },
  );
}

function options(fetch: ExplorerFetch, extra: ExplorerRequestOptions = {}) {
  return {
    token: "secret-token",
    fetch,
    ...extra,
    limiter: extra.limiter ?? createExplorerLimiter(extra.now),
  };
}

function expectKind(kind: string) {
  return (cause: unknown) =>
    cause instanceof ExplorerError &&
    cause.kind === kind &&
    cause.reason === kind &&
    !cause.message.includes("secret-token");
}

test("exports the exact supported speed and rating filters", () => {
  assert.deepEqual(LICHESS_SPEEDS, [
    "ultraBullet",
    "bullet",
    "blitz",
    "rapid",
    "classical",
    "correspondence",
  ]);
  assert.deepEqual(LICHESS_RATINGS, [
    0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500,
  ]);
  assert.equal(EXPLORER_MAX_RESPONSE_BYTES, 1024 * 1024);
  assert.equal(EXPLORER_MAX_MOVES, 256);
  assert.equal(EXPLORER_MAX_STRING_LENGTH, 256);
  assert.equal(EXPLORER_MAX_COOLDOWN_MS, 2_147_483_647);
});

test("builds the request and maps a validated response", async () => {
  let input = "";
  let init: RequestInit | undefined;
  const fetch: ExplorerFetch = async (nextInput, nextInit) => {
    input = String(nextInput);
    init = nextInit;
    return response();
  };

  const result = await openingExplorer(
    new Chess(),
    "lichess",
    ["ultraBullet", "rapid"],
    [0, 2500],
    options(fetch),
  );

  const url = new URL(input);
  assert.equal(url.pathname, "/lichess");
  assert.equal(url.searchParams.get("fen"), new Chess().fen());
  assert.equal(url.searchParams.get("speeds"), "ultraBullet,rapid");
  assert.equal(url.searchParams.get("ratings"), "0,2500");
  assert.equal(
    (init?.headers as Record<string, string>).Authorization,
    "Bearer secret-token",
  );
  assert.deepEqual(result, {
    db: "lichess",
    white: 10,
    draws: 5,
    black: 7,
    moves: [
      {
        uci: "e2e4",
        san: "e4",
        white: 4,
        draws: 2,
        black: 3,
        count: 9,
        averageRating: 1812,
      },
    ],
    opening: { eco: "B00", name: "King's Pawn Game" },
  });
});

test("uses one plain snapshot of direct API filter arrays", async () => {
  const speeds = ["blitz"];
  const ratings = [1800];
  let speedIterations = 0;
  let ratingIterations = 0;
  speeds[Symbol.iterator] = function* () {
    speedIterations += 1;
    yield "rapid";
    return undefined;
  };
  ratings[Symbol.iterator] = function* () {
    ratingIterations += 1;
    yield 2000;
    return undefined;
  };
  speeds.join = () => "invalid";
  ratings.join = () => "9999";
  let input = "";

  await openingExplorer(
    new Chess(),
    "lichess",
    speeds,
    ratings,
    options(async (nextInput) => {
      input = String(nextInput);
      return response();
    }),
  );

  const url = new URL(input);
  assert.equal(url.searchParams.get("speeds"), "rapid");
  assert.equal(url.searchParams.get("ratings"), "2000");
  assert.equal(speedIterations, 1);
  assert.equal(ratingIterations, 1);
});

test("rejects unsupported filters before fetching", async () => {
  let calls = 0;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    return response();
  };

  await assert.rejects(
    openingExplorer(new Chess(), "lichess", ["standard"], [], options(fetch)),
    expectKind("invalid_input"),
  );
  await assert.rejects(
    openingExplorer(new Chess(), "lichess", [], [1500], options(fetch)),
    expectKind("invalid_input"),
  );
  await assert.rejects(
    openingExplorer(new Chess(), "lichess", ["blitz", "blitz"], [], options(fetch)),
    expectKind("invalid_input"),
  );
  await assert.rejects(
    openingExplorer(new Chess(), "masters", ["rapid"], [], options(fetch)),
    expectKind("invalid_input"),
  );
  await assert.rejects(
    openingExplorer(
      new Chess(),
      "../player" as never,
      [],
      [],
      options(fetch),
    ),
    expectKind("invalid_input"),
  );
  for (const [speeds, ratings] of [
    [Array(1), []],
    [["blitz", ,], []],
    [[], Array(1)],
  ] as const) {
    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        speeds as readonly string[],
        ratings as readonly number[],
        options(fetch),
      ),
      expectKind("invalid_input"),
    );
  }
  assert.equal(calls, 0);
});

test("retries one network failure with the default delay", async () => {
  let calls = 0;
  const delays: number[] = [];
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("request included secret-token");
    return response();
  };

  await openingExplorer(
    new Chess(),
    "masters",
    [],
    [],
    options(fetch, { sleep: async (ms) => void delays.push(ms) }),
  );

  assert.equal(calls, 2);
  assert.deepEqual(delays, [250]);
});

test("preserves a network failure when the default backoff would exhaust its budget", async () => {
  let now = 0;
  let calls = 0;
  const delays: number[] = [];

  await assert.rejects(
    openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(
        async () => {
          calls += 1;
          now = EXPLORER_TOTAL_TIMEOUT_MS - EXPLORER_DEFAULT_RETRY_DELAY_MS;
          throw new TypeError("network failure");
        },
        {
          now: () => now,
          sleep: async (ms) => {
            delays.push(ms);
            now += ms;
          },
        },
      ),
    ),
    expectKind("network"),
  );

  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("rethrows caller cancellation without retrying or converting it", async () => {
  const controller = new AbortController();
  const cause = new Error("caller cancelled");
  let calls = 0;
  const fetch: ExplorerFetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      calls += 1;
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
        once: true,
      });
    });

  const pending = openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(fetch, { signal: controller.signal }),
  );
  controller.abort(cause);

  await assert.rejects(pending, (error: unknown) => error === cause);
  assert.equal(calls, 1);
});

test("aborts an uncooperative fetch and cancels its late response", async () => {
  const limiter = createExplorerLimiter();
  const controller = new AbortController();
  const cause = new Error("caller cancelled an uncooperative fetch");
  let calls = 0;
  let cancelled = 0;
  let resolveFirst: ((response: Response) => void) | undefined;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    if (calls > 1) return response();
    return await new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
  };
  const first = openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(fetch, { limiter, signal: controller.signal }),
  );
  const second = openingExplorer(
    new Chess(),
    "masters",
    [],
    [],
    options(fetch, { limiter }),
  );

  controller.abort(cause);
  await assert.rejects(first, (error: unknown) => error === cause);
  await second;
  resolveFirst?.(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled += 1;
        },
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(calls, 2);
  assert.equal(cancelled, 1);
  assert.equal(limiter.pending, 0);
});

test("applies attempt timeouts to an uncooperative fetch", async () => {
  const attempts = [new AbortController(), new AbortController()];
  let calls = 0;
  const pending = openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(
      async () => {
        calls += 1;
        return await new Promise<Response>(() => {});
      },
      {
        sleep: async () => undefined,
        timeout: () => attempts[calls]?.signal ?? AbortSignal.abort(),
      },
    ),
  );

  attempts[0]?.abort();
  await new Promise<void>((resolve) => {
    const check = () => {
      if (calls === 2) return resolve();
      queueMicrotask(check);
    };
    check();
  });
  attempts[1]?.abort();

  await assert.rejects(pending, expectKind("timeout"));
  assert.equal(calls, 2);
});

test("cancels a response when caller cancellation wins after fetch resolution", async () => {
  const controller = new AbortController();
  const cause = new Error("caller cancelled after fetch resolution");
  let cancelled = 0;
  let resolveFetch: ((response: Response) => void) | undefined;
  const fetch: ExplorerFetch = async () =>
    await new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
  const pending = openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(fetch, { signal: controller.signal }),
  );
  resolveFetch?.(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled += 1;
        },
      }),
    ),
  );
  queueMicrotask(() => controller.abort(cause));

  await assert.rejects(pending, (error: unknown) => error === cause);
  assert.equal(cancelled, 1);
});

test("handles body cancellation rejection after both abort signals fire", async () => {
  const caller = new AbortController();
  const attempt = new AbortController();
  const cause = new Error("caller won the response race");
  let unhandled: unknown;
  const onUnhandled = (error: unknown) => {
    unhandled = error;
  };
  process.once("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        [],
        [],
        options(
          async () => {
            const response = new Response(
              new ReadableStream({
                cancel: () => Promise.reject(new Error("cancel failed")),
              }),
            );
            return new Proxy(response, {
              get(target, property) {
                if (property === "ok") {
                  queueMicrotask(() => {
                    attempt.abort();
                    caller.abort(cause);
                  });
                }
                return Reflect.get(target, property, target) as unknown;
              },
            });
          },
          { signal: caller.signal, timeout: () => attempt.signal },
        ),
      ),
      (error: unknown) => error === cause,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("does not fetch when the caller already cancelled", async () => {
  const controller = new AbortController();
  const cause = new Error("already cancelled");
  let calls = 0;
  controller.abort(cause);

  await assert.rejects(
    openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(async () => {
        calls += 1;
        return response();
      }, { signal: controller.signal }),
    ),
    (error: unknown) => error === cause,
  );
  assert.equal(calls, 0);
});

test("returns stable errors for invalid or backward request clocks", async () => {
  for (const values of [
    [Number.NaN],
    [Infinity],
    [-Infinity],
    [Number.MAX_VALUE],
    [-Number.MAX_VALUE],
    [100, 99],
  ]) {
    let calls = 0;
    let index = 0;
    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        [],
        [],
        options(
          async () => {
            calls += 1;
            return response();
          },
          {
            limiter: createExplorerLimiter(() => 0),
            now: () => values[Math.min(index++, values.length - 1)]!,
          },
        ),
      ),
      expectKind("invalid_input"),
    );
    assert.equal(calls, 0);
  }
});

test("accepts finite monotonic fractional request clocks", async () => {
  let now = 0.25;
  await openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(async () => response(), {
      limiter: createExplorerLimiter(() => now),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    }),
  );
});

test("allows safe request clocks to advance through deadline boundaries", async () => {
  for (const start of [
    Number.MAX_SAFE_INTEGER - EXPLORER_TOTAL_TIMEOUT_MS,
    -Number.MAX_SAFE_INTEGER,
  ]) {
    let now = start;
    let calls = 0;
    await openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(
        async () => {
          calls += 1;
          return response();
        },
        {
          limiter: createExplorerLimiter(() => 0),
          now: () => now++,
        },
      ),
    );
    assert.equal(calls, 1);
  }
});

test("rejects unsafe request clocks and deadline sums before fetching", async () => {
  for (const start of [
    Number.MAX_SAFE_INTEGER - EXPLORER_TOTAL_TIMEOUT_MS + 1,
    Number.MAX_SAFE_INTEGER + 2,
    -Number.MAX_SAFE_INTEGER - 2,
  ]) {
    let calls = 0;
    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        [],
        [],
        options(
          async () => {
            calls += 1;
            return response();
          },
          {
            limiter: createExplorerLimiter(() => 0),
            now: () => start,
          },
        ),
      ),
      expectKind("invalid_input"),
    );
    assert.equal(calls, 0);
  }
});

test("cancels retry backoff before another fetch", async () => {
  const controller = new AbortController();
  const cause = new Error("caller cancelled during backoff");
  let calls = 0;
  let startedSleep: (() => void) | undefined;
  const pending = openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(
      async () => {
        calls += 1;
        throw new TypeError("network failure");
      },
      {
        signal: controller.signal,
        sleep: async () =>
          await new Promise<void>((resolve) => {
            startedSleep = resolve;
          }),
      },
    ),
  );

  await new Promise<void>((resolve) => {
    const check = () => {
      if (startedSleep) return resolve();
      queueMicrotask(check);
    };
    check();
  });
  controller.abort(cause);

  await assert.rejects(pending, (error: unknown) => error === cause);
  assert.equal(calls, 1);
});

test("retries timed out attempts and returns a stable error", async () => {
  let calls = 0;
  const timeouts: number[] = [];
  const fetch: ExplorerFetch = async (_input, init) => {
    calls += 1;
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException("secret-token", "TimeoutError");
  };

  await assert.rejects(
    openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(fetch, {
        sleep: async () => undefined,
        timeout: (ms) => {
          timeouts.push(ms);
          return AbortSignal.abort();
        },
      }),
    ),
    expectKind("timeout"),
  );

  assert.equal(calls, 2);
  assert.deepEqual(timeouts, [
    EXPLORER_ATTEMPT_TIMEOUT_MS,
    EXPLORER_ATTEMPT_TIMEOUT_MS,
  ]);
});

test("honors bounded Retry-After for 429 and 5xx", async () => {
  for (const [status, retryAfter, expected] of [
    [429, "1", 1000],
    [503, "2", 2000],
  ] as const) {
    let now = 0;
    let calls = 0;
    const delays: number[] = [];
    const fetch: ExplorerFetch = async () => {
      calls += 1;
      return calls === 1
        ? response(status, { private: "secret-token" }, { "Retry-After": retryAfter })
        : response();
    };

    await openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(fetch, {
        now: () => now,
        sleep: async (ms) => {
          delays.push(ms);
          now += ms;
        },
      }),
    );
    assert.equal(calls, 2);
    assert.deepEqual(delays, [expected]);
  }
});

test("serializes process-wide explorer requests", async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let releaseFirst: (() => void) | undefined;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return response();
    } finally {
      active -= 1;
    }
  };
  const requestOptions = { token: "process-token", fetch };

  const first = openingExplorer(new Chess(), "lichess", [], [], requestOptions);
  const second = openingExplorer(new Chess(), "masters", [], [], requestOptions);
  assert.equal(calls, 1);
  releaseFirst?.();

  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test("holds the explorer slot until a successful body is consumed", async () => {
  const limiter = createExplorerLimiter();
  const encoder = new TextEncoder();
  let calls = 0;
  let finishBody: (() => void) | undefined;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    if (calls > 1) return response();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify(validBody)));
          finishBody = () => controller.close();
        },
      }),
    );
  };
  const requestOptions = { token: "secret-token", fetch, limiter };
  const first = openingExplorer(new Chess(), "lichess", [], [], requestOptions);
  const second = openingExplorer(new Chess(), "masters", [], [], requestOptions);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  finishBody?.();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test("removes cancelled explorer requests from the shared queue", async () => {
  const limiter = createExplorerLimiter();
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return response();
  };
  const first = openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(fetch, { limiter }),
  );
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const queued = controllers.map((controller) =>
    openingExplorer(
      new Chess(),
      "masters",
      [],
      [],
      options(fetch, { limiter, signal: controller.signal }),
    ),
  );

  assert.equal(limiter.pending, controllers.length);
  const causes = controllers.map(() => new Error("queued request cancelled"));
  controllers.forEach((controller, index) => controller.abort(causes[index]));
  const results = await Promise.allSettled(queued);
  assert.ok(
    results.every(
      (result, index) =>
        result.status === "rejected" && result.reason === causes[index],
    ),
  );
  assert.equal(limiter.pending, 0);

  releaseFirst?.();
  await first;
  assert.equal(calls, 1);
});

test("cancels a non-OK body before releasing the shared request slot", async () => {
  const limiter = createExplorerLimiter();
  let calls = 0;
  let finishCancel: (() => void) | undefined;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    if (calls > 1) return response();
    return new Response(
      new ReadableStream({
        cancel: () =>
          new Promise<void>((resolve) => {
            finishCancel = resolve;
          }),
      }),
      { status: 404 },
    );
  };
  const first = openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(fetch, { limiter }),
  );
  const second = openingExplorer(
    new Chess(),
    "masters",
    [],
    [],
    options(fetch, { limiter }),
  );

  await new Promise<void>((resolve) => {
    const check = () => {
      if (finishCancel) return resolve();
      queueMicrotask(check);
    };
    check();
  });
  assert.equal(calls, 1);
  assert.equal(limiter.pending, 1);
  finishCancel?.();

  await assert.rejects(first, expectKind("http"));
  await second;
  assert.equal(calls, 2);
});

test("waits for non-OK body cancellation before releasing a cancelled request", async () => {
  const limiter = createExplorerLimiter();
  const controller = new AbortController();
  const cause = new Error("caller cancelled during non-OK cleanup");
  let calls = 0;
  let finishCancel: (() => void) | undefined;
  let beginCancel: (() => void) | undefined;
  const cancellationStarted = new Promise<void>((resolve) => {
    beginCancel = resolve;
  });
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    if (calls > 1) return response();
    return new Response(
      new ReadableStream({
        cancel: () => {
          beginCancel?.();
          return new Promise<void>((resolve) => {
            finishCancel = resolve;
          });
        },
      }),
      { status: 404 },
    );
  };
  const first = openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(fetch, { limiter, signal: controller.signal }),
  );
  const second = openingExplorer(
    new Chess(),
    "masters",
    [],
    [],
    options(fetch, { limiter }),
  );

  await cancellationStarted;
  controller.abort(cause);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(limiter.pending, 1);

  finishCancel?.();
  await assert.rejects(first, (error: unknown) => error === cause);
  await second;
  assert.equal(calls, 2);
});

test("bounds stalled non-OK body cancellation by the attempt timeout", async () => {
  const limiter = createExplorerLimiter();
  const caller = new AbortController();
  const attempt = new AbortController();
  const cause = new Error("caller cancelled during stalled cleanup");
  let calls = 0;
  let beginCancel: (() => void) | undefined;
  const cancellationStarted = new Promise<void>((resolve) => {
    beginCancel = resolve;
  });
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    if (calls > 1) return response();
    return new Response(
      new ReadableStream({
        cancel: () => {
          beginCancel?.();
          return new Promise<void>(() => {});
        },
      }),
      { status: 404 },
    );
  };
  const requestOptions = options(fetch, {
    limiter,
    timeout: () => (calls === 0 ? attempt.signal : AbortSignal.timeout(1_000)),
  });
  const first = openingExplorer(new Chess(), "lichess", [], [], {
    ...requestOptions,
    signal: caller.signal,
  });
  const second = openingExplorer(
    new Chess(),
    "masters",
    [],
    [],
    requestOptions,
  );

  await cancellationStarted;
  caller.abort(cause);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(limiter.pending, 1);

  attempt.abort();
  await assert.rejects(first, (error: unknown) => error === cause);
  await second;
  assert.equal(calls, 2);
});

test("preserves a 429 cooldown when response cleanup times out", async () => {
  const limiter = createExplorerLimiter();
  const attempt = new AbortController();
  let calls = 0;
  let beginCancel: (() => void) | undefined;
  const cancellationStarted = new Promise<void>((resolve) => {
    beginCancel = resolve;
  });
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    return new Response(
      new ReadableStream({
        cancel: () => {
          beginCancel?.();
          return new Promise<void>(() => {});
        },
      }),
      { status: 429, headers: { "Retry-After": "60" } },
    );
  };
  const requestOptions = options(fetch, {
    limiter,
    now: () => 0,
    timeout: () => attempt.signal,
  });
  const first = openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    requestOptions,
  );

  await cancellationStarted;
  attempt.abort();
  await assert.rejects(first, expectKind("rate_limited"));
  await assert.rejects(
    openingExplorer(new Chess(), "masters", [], [], requestOptions),
    expectKind("rate_limited"),
  );
  assert.equal(calls, 1);
});

test("bounds stalled successful body cancellation by the attempt timeout", async () => {
  const limiter = createExplorerLimiter();
  const attempt = new AbortController();
  let calls = 0;
  let beginRead: (() => void) | undefined;
  const bodyReadStarted = new Promise<void>((resolve) => {
    beginRead = resolve;
  });
  let beginCancel: (() => void) | undefined;
  const cancellationStarted = new Promise<void>((resolve) => {
    beginCancel = resolve;
  });
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    if (calls > 1) return response();
    return new Response(
      new ReadableStream({
        pull: () => {
          beginRead?.();
          return new Promise<void>(() => {});
        },
        cancel: () => {
          beginCancel?.();
          return new Promise<void>(() => {});
        },
      }),
    );
  };
  const requestOptions = options(fetch, {
    limiter,
    sleep: async () => undefined,
    timeout: () => (calls === 0 ? attempt.signal : AbortSignal.timeout(1_000)),
  });
  const first = openingExplorer(new Chess(), "lichess", [], [], requestOptions);
  const second = openingExplorer(
    new Chess(),
    "masters",
    [],
    [],
    requestOptions,
  );

  await bodyReadStarted;
  attempt.abort();
  await cancellationStarted;
  await Promise.all([first, second]);
  assert.equal(calls, 3);
});

test("bounds stalled successful cleanup after caller cancellation", async () => {
  const limiter = createExplorerLimiter();
  const caller = new AbortController();
  const attempt = new AbortController();
  const cause = new Error("caller cancelled during stalled successful cleanup");
  let calls = 0;
  let beginRead: (() => void) | undefined;
  const bodyReadStarted = new Promise<void>((resolve) => {
    beginRead = resolve;
  });
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    if (calls > 1) return response();
    return new Response(
      new ReadableStream({
        pull: () => {
          beginRead?.();
          return new Promise<void>(() => {});
        },
        cancel: () => new Promise<void>(() => {}),
      }),
    );
  };
  const requestOptions = options(fetch, {
    limiter,
    timeout: () => (calls === 0 ? attempt.signal : AbortSignal.timeout(1_000)),
  });
  const first = openingExplorer(new Chess(), "lichess", [], [], {
    ...requestOptions,
    signal: caller.signal,
  });
  const second = openingExplorer(
    new Chess(),
    "masters",
    [],
    [],
    requestOptions,
  );

  await bodyReadStarted;
  caller.abort(cause);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(limiter.pending, 1);

  attempt.abort();
  await assert.rejects(first, (error: unknown) => error === cause);
  await second;
  assert.equal(calls, 2);
});

test("coordinates a shared 429 cooldown across queued explorer calls", async () => {
  let now = 0;
  const limiter = createExplorerLimiter(() => now);
  let calls = 0;
  const delays: number[] = [];
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    return calls === 1
      ? response(429, {}, { "Retry-After": "1" })
      : response();
  };
  const requestOptions = {
    token: "shared-token",
    fetch,
    limiter,
    now: () => now,
    sleep: async (ms: number) => {
      delays.push(ms);
      now += ms;
    },
  };

  await Promise.all([
    openingExplorer(new Chess(), "lichess", [], [], requestOptions),
    openingExplorer(new Chess(), "masters", [], [], requestOptions),
  ]);

  assert.equal(calls, 3);
  assert.deepEqual(delays, [1_000]);
});

test("keeps shared cooldowns on the limiter clock domain", async () => {
  let limiterNow = 0;
  const limiter = createExplorerLimiter(() => limiterNow);
  let calls = 0;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    return calls === 1
      ? response(429, {}, { "Retry-After": "60" })
      : response();
  };

  await assert.rejects(
    openingExplorer(new Chess(), "lichess", [], [], {
      token: "shared-token",
      fetch,
      limiter,
      now: Date.now,
    }),
    expectKind("rate_limited"),
  );
  await assert.rejects(
    openingExplorer(new Chess(), "masters", [], [], {
      token: "shared-token",
      fetch,
      limiter,
      now: () => 0,
    }),
    expectKind("rate_limited"),
  );
  assert.equal(calls, 1);

  limiterNow = EXPLORER_RATE_LIMIT_COOLDOWN_MS;
  await openingExplorer(new Chess(), "masters", [], [], {
    token: "shared-token",
    fetch,
    limiter,
    now: () => 0,
  });
  assert.equal(calls, 2);
});

test("does not trust early cooldown sleeps or ignore cooldown extensions", async () => {
  for (const extend of [false, true]) {
    let now = 0;
    let calls = 0;
    let wake: (() => void) | undefined;
    const limiter = createExplorerLimiter(() => now);
    limiter.cooldown(1_000, 0);
    const pending = limiter.run(
      {
        callerSignal: undefined,
        deadline: 12_000,
        now: () => 0,
        sleep: async () =>
          await new Promise<void>((resolve) => {
            wake = resolve;
          }),
      },
      async () => {
        calls += 1;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (extend) limiter.cooldown(5_000, 0);
    wake?.();

    await assert.rejects(pending, expectKind("rate_limited"));
    assert.equal(now, 0);
    assert.equal(calls, 0);
  }
});

test("preserves the original 429 after cooldown fail-fast", async () => {
  let now = 0;
  let calls = 0;
  await assert.rejects(
    openingExplorer(new Chess(), "lichess", [], [], {
      token: "shared-token",
      limiter: createExplorerLimiter(() => now),
      now: () => now,
      sleep: async () => undefined,
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? response(429, {}, { "Retry-After": "1" })
          : response();
      },
    }),
    (error: unknown) =>
      error instanceof ExplorerError &&
      error.kind === "rate_limited" &&
      error.status === 429,
  );
  assert.equal(calls, 1);
});

test("propagates the latest custom limiter rate-limit error", async () => {
  const customError = new ExplorerError(
    "rate_limited",
    "custom limiter quota exhausted",
  );
  let runs = 0;
  let calls = 0;
  const limiter: ExplorerLimiter = {
    pending: 0,
    cooldown: () => undefined,
    run: async (_options, request) => {
      runs += 1;
      if (runs > 1) throw customError;
      return await request();
    },
  };

  await assert.rejects(
    openingExplorer(new Chess(), "lichess", [], [], {
      token: "shared-token",
      limiter,
      now: () => 0,
      wallNow: () => 0,
      fetch: async () => {
        calls += 1;
        return response(429, {}, { "Retry-After": "0" });
      },
    }),
    (error: unknown) => error === customError,
  );
  assert.equal(runs, 2);
  assert.equal(calls, 1);
});

test("fails fast for invalid or backward limiter clocks", async () => {
  for (const values of [
    [Number.NaN],
    [Infinity],
    [Number.MAX_VALUE],
    [1, 0],
  ]) {
    let index = 0;
    const limiter = createExplorerLimiter(
      () => values[Math.min(index++, values.length - 1)]!,
    );
    if (values.length === 1) {
      assert.throws(
        () => limiter.cooldown(1_000, 0),
        expectKind("invalid_input"),
      );
      continue;
    }
    limiter.cooldown(1_000, 0);
    await assert.rejects(
      limiter.run(
        {
          callerSignal: undefined,
          deadline: 12_000,
          now: () => 0,
          sleep: async () => undefined,
        },
        async () => undefined,
      ),
      expectKind("invalid_input"),
    );
  }
});

test("allows safe limiter clocks to advance after boundary cooldowns", async () => {
  for (const start of [
    Number.MAX_SAFE_INTEGER - EXPLORER_MAX_COOLDOWN_MS,
    -Number.MAX_SAFE_INTEGER,
  ]) {
    let now = start;
    let calls = 0;
    const limiter = createExplorerLimiter(() => now);
    limiter.cooldown(EXPLORER_MAX_COOLDOWN_MS, 0);
    now += 1;
    await limiter.run(
      {
        callerSignal: undefined,
        deadline: EXPLORER_MAX_COOLDOWN_MS + 1,
        now: () => 0,
        sleep: async (ms) => {
          now += ms;
        },
      },
      async () => {
        calls += 1;
      },
    );
    assert.equal(calls, 1);
  }
});

test("rejects unsafe limiter clocks and cooldown sums", () => {
  for (const now of [
    Number.MAX_SAFE_INTEGER + 2,
    -Number.MAX_SAFE_INTEGER - 2,
  ]) {
    const limiter = createExplorerLimiter(() => now);
    assert.throws(
      () => limiter.cooldown(0, 0),
      expectKind("invalid_input"),
    );
  }

  const limiter = createExplorerLimiter(
    () => Number.MAX_SAFE_INTEGER - EXPLORER_MAX_COOLDOWN_MS + 1,
  );
  assert.throws(
    () => limiter.cooldown(EXPLORER_MAX_COOLDOWN_MS, 0),
    expectKind("invalid_input"),
  );
});

test("validates cooldown durations before mutating limiter state", async () => {
  let now = 0;
  const limiter = createExplorerLimiter(() => now);
  limiter.cooldown(1_000, 0);
  for (const delay of [
    Number.NaN,
    Infinity,
    -1,
    0.5,
    EXPLORER_MAX_COOLDOWN_MS + 1,
  ]) {
    assert.throws(
      () => limiter.cooldown(delay, 0),
      expectKind("invalid_input"),
    );
  }

  await assert.rejects(
    limiter.run(
      {
        callerSignal: undefined,
        deadline: 12_000,
        now: () => 0,
        sleep: async () => undefined,
      },
      async () => undefined,
    ),
    expectKind("rate_limited"),
  );
  now = 1_000;
  await limiter.run(
    {
      callerSignal: undefined,
      deadline: 12_000,
      now: () => 0,
      sleep: async () => undefined,
    },
    async () => undefined,
  );

  const zero = createExplorerLimiter(() => 0);
  zero.cooldown(0, 0);
  await zero.run(
    {
      callerSignal: undefined,
      deadline: 12_000,
      now: () => 0,
      sleep: async () => undefined,
    },
    async () => undefined,
  );

  let maximumNow = 0;
  const maximum = createExplorerLimiter(() => maximumNow);
  maximum.cooldown(EXPLORER_MAX_COOLDOWN_MS, 0);
  maximumNow = EXPLORER_MAX_COOLDOWN_MS;
  await maximum.run(
    {
      callerSignal: undefined,
      deadline: 12_000,
      now: () => 0,
      sleep: async () => undefined,
    },
    async () => undefined,
  );
});

test("caps public rate-limit delays to the public cooldown maximum", () => {
  assert.equal(
    rateLimitCooldownMs(String(Math.floor(EXPLORER_MAX_COOLDOWN_MS / 1_000)), 0),
    2_147_483_000,
  );
  assert.equal(
    rateLimitCooldownMs(
      String(Math.ceil(EXPLORER_MAX_COOLDOWN_MS / 1_000)),
      0,
    ),
    EXPLORER_MAX_COOLDOWN_MS,
  );
});

test("uses a one-minute shared cooldown when a 429 lacks Retry-After", async () => {
  let now = 0;
  const limiter = createExplorerLimiter(() => now);
  let calls = 0;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    return calls === 1 ? response(429) : response();
  };
  const requestOptions = {
    token: "shared-token",
    fetch,
    limiter,
    now: () => now,
    sleep: async () => undefined,
  };

  await assert.rejects(
    openingExplorer(new Chess(), "lichess", [], [], requestOptions),
    expectKind("rate_limited"),
  );
  await assert.rejects(
    openingExplorer(new Chess(), "masters", [], [], requestOptions),
    expectKind("rate_limited"),
  );
  assert.equal(calls, 1);

  now = EXPLORER_RATE_LIMIT_COOLDOWN_MS;
  await openingExplorer(new Chess(), "masters", [], [], requestOptions);
  assert.equal(calls, 2);
});

test("fails fast when a shared cooldown exceeds the request budget", async () => {
  const limiter = createExplorerLimiter(() => 0);
  const delays: number[] = [];
  limiter.cooldown(EXPLORER_RATE_LIMIT_COOLDOWN_MS, 0);

  await assert.rejects(
    openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(async () => response(), {
        limiter,
        now: () => 0,
        sleep: async (ms) => void delays.push(ms),
      }),
    ),
    expectKind("rate_limited"),
  );
  assert.deepEqual(delays, []);
});

test("cancels while waiting for a shared cooldown", async () => {
  const limiter = createExplorerLimiter(() => 0);
  const controller = new AbortController();
  const cause = new Error("caller cancelled during cooldown");
  let calls = 0;
  let startedSleep: (() => void) | undefined;
  limiter.cooldown(1_000, 0);

  const pending = openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(
      async () => {
        calls += 1;
        return response();
      },
      {
        limiter,
        now: () => 0,
        signal: controller.signal,
        sleep: async () =>
          await new Promise<void>((resolve) => {
            startedSleep = resolve;
          }),
      },
    ),
  );

  await new Promise<void>((resolve) => {
    const check = () => {
      if (startedSleep) return resolve();
      queueMicrotask(check);
    };
    check();
  });
  controller.abort(cause);

  await assert.rejects(pending, (error: unknown) => error === cause);
  assert.equal(calls, 0);
});

test("does not retry after Retry-After exceeds the request budget", async () => {
  let calls = 0;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    return response(429, {}, { "Retry-After": "60" });
  };

  await assert.rejects(
    openingExplorer(new Chess(), "lichess", [], [], options(fetch)),
    (cause: unknown) =>
      cause instanceof ExplorerError &&
      expectKind("rate_limited")(cause) &&
      cause.status === 429,
  );
  assert.equal(calls, 1);
});

test("does not retry other HTTP failures", async () => {
  let calls = 0;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    return response(404, { token: "secret-token" });
  };

  await assert.rejects(
    openingExplorer(new Chess(), "lichess", [], [], options(fetch)),
    (cause: unknown) =>
      cause instanceof ExplorerError &&
      expectKind("http")(cause) &&
      cause.status === 404,
  );
  assert.equal(calls, 1);
});

test("returns a stable auth error for 401 and 403 without retrying", async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const fetch: ExplorerFetch = async () => {
      calls += 1;
      return response(status, { token: "secret-token" });
    };

    await assert.rejects(
      openingExplorer(new Chess(), "lichess", [], [], options(fetch)),
      (cause: unknown) =>
        cause instanceof ExplorerError &&
        expectKind("auth")(cause) &&
        cause.status === status,
    );
    assert.equal(calls, 1);
  }
});

test("returns stable exhausted retry errors", async () => {
  for (const [status, kind] of [
    [429, "rate_limited"],
    [500, "upstream"],
  ] as const) {
    let calls = 0;
    const fetch: ExplorerFetch = async () => {
      calls += 1;
      return response(status, { token: "secret-token" });
    };

    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        [],
        [],
        options(fetch, { sleep: async () => undefined }),
      ),
      expectKind(kind),
    );
    assert.equal(calls, status === 429 ? 1 : 2);
  }
});

test("rejects malformed successful JSON without retrying", async () => {
  let calls = 0;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    return response(200, { ...validBody, white: "10" });
  };

  await assert.rejects(
    openingExplorer(new Chess(), "lichess", [], [], options(fetch)),
    expectKind("invalid_response"),
  );
  assert.equal(calls, 1);
});

test("rejects a fractional average rating", async () => {
  await assert.rejects(
    openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(async () =>
        response(200, {
          ...validBody,
          moves: [{ ...validBody.moves[0], averageRating: 1812.5 }],
        }),
      ),
    ),
    expectKind("invalid_response"),
  );
});

test("rejects illegal and duplicate upstream moves", async () => {
  for (const moves of [
    [{ ...validBody.moves[0], uci: "e2e5", san: "e5" }],
    [validBody.moves[0], validBody.moves[0]],
  ]) {
    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        [],
        [],
        options(async () => response(200, { ...validBody, moves })),
      ),
      expectKind("invalid_response"),
    );
  }
});

test("rejects a missing token before fetching", async () => {
  let calls = 0;
  await assert.rejects(
    openingExplorer(new Chess(), "lichess", [], [], {
      token: "",
      fetch: async () => {
        calls += 1;
        return response();
      },
    }),
    expectKind("disabled"),
  );
  assert.equal(calls, 0);
});

test("omits empty filters and maps optional response fields to null", async () => {
  let input = "";
  const result = await openingExplorer(
    new Chess(),
    "masters",
    [],
    [],
    options(async (nextInput) => {
      input = String(nextInput);
      return response(200, {
        ...validBody,
        moves: [{ ...validBody.moves[0], averageRating: undefined }],
        opening: undefined,
      });
    }),
  );

  const url = new URL(input);
  assert.equal(url.searchParams.has("speeds"), false);
  assert.equal(url.searchParams.has("ratings"), false);
  assert.equal(result.moves[0]?.averageRating, null);
  assert.equal(result.opening, null);
});

test("uses a wall clock for HTTP-date Retry-After", async () => {
  let now = 0;
  const wallNow = Date.parse("2026-08-21T00:00:00Z");
  let calls = 0;
  const delays: number[] = [];
  await openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(
      async () => {
        calls += 1;
        return calls === 1
          ? response(429, {}, {
              "Retry-After": "Fri, 21 Aug 2026 00:00:01 GMT",
            })
          : response();
      },
      {
        now: () => now,
        wallNow: () => wallNow,
        sleep: async (ms) => {
          delays.push(ms);
          now += ms;
        },
      },
    ),
  );
  assert.deepEqual(delays, [1_000]);
});

test("accepts obsolete valid HTTP-date Retry-After forms", async () => {
  const target = Date.parse("1994-11-06T08:49:37Z");
  for (const retryAfter of [
    "Sunday, 06-Nov-94 08:49:37 GMT",
    "Sun Nov  6 08:49:37 1994",
    "Sun Nov 06 08:49:37 1994",
  ]) {
    let now = 0;
    let calls = 0;
    const delays: number[] = [];
    await openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(
        async () => {
          calls += 1;
          return calls === 1
            ? response(429, {}, { "Retry-After": retryAfter })
            : response();
        },
        {
          now: () => now,
          wallNow: () => target - 1_000,
          sleep: async (ms) => {
            delays.push(ms);
            now += ms;
          },
        },
      ),
    );
    assert.deepEqual(delays, [1_000]);
  }
});

test("interprets RFC 850 dates more than fifty years ahead as past", async () => {
  const delays: number[] = [];
  let calls = 0;
  await openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(
      async () => {
        calls += 1;
        return calls === 1
          ? response(503, {}, {
              "Retry-After": "Saturday, 31-Dec-77 00:00:00 GMT",
            })
          : response();
      },
      {
        now: () => 0,
        wallNow: () => Date.parse("2027-01-01T00:00:00Z"),
        sleep: async (ms) => void delays.push(ms),
      },
    ),
  );
  assert.deepEqual(delays, [0]);
});

test("applies the RFC 850 fifty-year rule in arbitrary centuries", async () => {
  const delays: number[] = [];
  let calls = 0;
  await openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(
      async () => {
        calls += 1;
        return calls === 1
          ? response(503, {}, {
              "Retry-After": "Sunday, 31-Dec-99 00:00:00 GMT",
            })
          : response();
      },
      {
        now: () => 0,
        wallNow: () => Date.parse("1900-01-01T00:00:00Z"),
        sleep: async (ms) => void delays.push(ms),
      },
    ),
  );
  assert.deepEqual(delays, [0]);
});

test("rejects HTTP dates with rollover or inconsistent weekdays", async () => {
  const wallNow = Date.parse("2026-09-30T23:59:59Z");
  for (const retryAfter of [
    "Thu, 31 Sep 2026 00:00:00 GMT",
    "Fri, 01 Oct 2026 00:00:00 GMT",
  ]) {
    let calls = 0;
    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        [],
        [],
        options(
          async () => {
            calls += 1;
            return calls === 1
              ? response(429, {}, { "Retry-After": retryAfter })
              : response();
          },
          { now: () => 0, wallNow: () => wallNow },
        ),
      ),
      expectKind("rate_limited"),
    );
    assert.equal(calls, 1);
  }
});

test("rejects malformed asctime spacing", async () => {
  const wallNow = Date.parse("1994-11-06T08:49:36Z");
  for (const retryAfter of [
    "Sun Nov 6 08:49:37 1994",
    "Sun Nov  06 08:49:37 1994",
  ]) {
    let calls = 0;
    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        [],
        [],
        options(
          async () => {
            calls += 1;
            return calls === 1
              ? response(429, {}, { "Retry-After": retryAfter })
              : response();
          },
          { now: () => 0, wallNow: () => wallNow },
        ),
      ),
      expectKind("rate_limited"),
    );
    assert.equal(calls, 1);
  }
});

test("uses fallback delays for invalid wall clocks and unsafe date delays", async () => {
  for (const wallNow of [9e15, -9e15]) {
    let calls = 0;
    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        [],
        [],
        options(
          async () => {
            calls += 1;
            return calls === 1
              ? response(429, {}, {
                  "Retry-After": "Fri, 01 Jan 2027 00:00:00 GMT",
                })
              : response();
          },
          { now: () => 0, wallNow: () => wallNow },
        ),
      ),
      expectKind("rate_limited"),
    );
    assert.equal(calls, 1);
  }
});

test("uses conservative cooldowns for malformed Retry-After values", async () => {
  for (const retryAfter of ["not-a-date", "-1", "1.5", "0x10", "1e2"]) {
    let calls = 0;
    const delays: number[] = [];
    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        [],
        [],
        options(
          async () => {
            calls += 1;
            return response(429, {}, { "Retry-After": retryAfter });
          },
          {
            now: () => 0,
            sleep: async (ms) => void delays.push(ms),
          },
        ),
      ),
      expectKind("rate_limited"),
    );
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  }
});

test("uses the default retry delay for malformed 5xx Retry-After", async () => {
  let calls = 0;
  const delays: number[] = [];
  await openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    options(
      async () => {
        calls += 1;
        return calls === 1
          ? response(503, {}, { "Retry-After": "-1" })
          : response();
      },
      { now: () => 0, sleep: async (ms) => void delays.push(ms) },
    ),
  );
  assert.deepEqual(delays, [EXPLORER_DEFAULT_RETRY_DELAY_MS]);
});

test("rejects invalid JSON and impossible aggregate counts", async () => {
  await assert.rejects(
    openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(async () => new Response("{", { status: 200 })),
    ),
    expectKind("invalid_response"),
  );
  await assert.rejects(
    openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(async () =>
        response(200, {
          ...validBody,
          white: 3,
        }),
      ),
    ),
    expectKind("invalid_response"),
  );
});

test("rejects unsafe derived explorer count sums", async () => {
  const count = Number.MAX_SAFE_INTEGER;
  for (const body of [
    { white: count, draws: count, black: 0, moves: [] },
    {
      white: count,
      draws: count,
      black: count,
      moves: [
        {
          uci: "e2e4",
          san: "e4",
          white: count,
          draws: count,
          black: count,
        },
      ],
    },
  ]) {
    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        [],
        [],
        options(async () => response(200, body)),
      ),
      expectKind("invalid_response"),
    );
  }
});

test("cancels explorer bodies as soon as they exceed the byte limit", async () => {
  let cancelled = false;
  await assert.rejects(
    openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new Uint8Array(EXPLORER_MAX_RESPONSE_BYTES + 1),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      ),
    ),
    expectKind("invalid_response"),
  );
  assert.equal(cancelled, true);
});

test("holds the explorer slot while oversized body cleanup is pending", async () => {
  const limiter = createExplorerLimiter();
  const attempt = new AbortController();
  let calls = 0;
  let beginCancel: (() => void) | undefined;
  const cancellationStarted = new Promise<void>((resolve) => {
    beginCancel = resolve;
  });
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    if (calls > 1) return response();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(EXPLORER_MAX_RESPONSE_BYTES + 1));
        },
        cancel() {
          beginCancel?.();
          return new Promise<void>(() => {});
        },
      }),
    );
  };
  const requestOptions = options(fetch, {
    limiter,
    timeout: () =>
      calls === 0 ? attempt.signal : AbortSignal.timeout(1_000),
  });
  const first = openingExplorer(
    new Chess(),
    "lichess",
    [],
    [],
    requestOptions,
  );
  const second = openingExplorer(
    new Chess(),
    "masters",
    [],
    [],
    requestOptions,
  );

  await cancellationStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(limiter.pending, 1);

  attempt.abort();
  await assert.rejects(first, expectKind("invalid_response"));
  await second;
  assert.equal(calls, 2);
});

test("rejects oversized explorer move arrays and strings", async () => {
  const move = validBody.moves[0];
  for (const body of [
    {
      ...validBody,
      moves: Array.from({ length: EXPLORER_MAX_MOVES + 1 }, () => move),
    },
    {
      ...validBody,
      opening: {
        eco: "A00",
        name: "x".repeat(EXPLORER_MAX_STRING_LENGTH + 1),
      },
    },
  ]) {
    await assert.rejects(
      openingExplorer(
        new Chess(),
        "lichess",
        [],
        [],
        options(async () => response(200, body)),
      ),
      expectKind("invalid_response"),
    );
  }
});

test("rejects malformed UTF-8 explorer JSON", async () => {
  const prefix = new TextEncoder().encode(
    '{"white":0,"draws":0,"black":0,"moves":[],"opening":{"eco":"A00","name":"',
  );
  const suffix = new TextEncoder().encode('"}}');
  const bytes = new Uint8Array(prefix.length + suffix.length + 1);
  bytes.set(prefix);
  bytes[prefix.length] = 0xff;
  bytes.set(suffix, prefix.length + 1);

  await assert.rejects(
    openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
      options(async () => new Response(bytes)),
    ),
    expectKind("invalid_response"),
  );
});
