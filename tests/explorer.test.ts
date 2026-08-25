import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chess.js";
import {
  EXPLORER_ATTEMPT_TIMEOUT_MS,
  EXPLORER_DEFAULT_RETRY_DELAY_MS,
  EXPLORER_RATE_LIMIT_COOLDOWN_MS,
  EXPLORER_TOTAL_TIMEOUT_MS,
  ExplorerError,
  LICHESS_RATINGS,
  LICHESS_SPEEDS,
  createExplorerLimiter,
  openingExplorer,
  type ExplorerFetch,
  type ExplorerRequestOptions,
} from "../src/explorer.js";

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
  return { token: "secret-token", fetch, limiter: createExplorerLimiter(), ...extra };
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
        now: () => 0,
        sleep: async (ms) => void delays.push(ms),
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

test("coordinates a shared 429 cooldown across queued explorer calls", async () => {
  const limiter = createExplorerLimiter();
  let now = 0;
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

test("uses a one-minute shared cooldown when a 429 lacks Retry-After", async () => {
  const limiter = createExplorerLimiter();
  let now = 0;
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
  const limiter = createExplorerLimiter();
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
  const limiter = createExplorerLimiter();
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

test("uses HTTP-date Retry-After and falls back for malformed values", async () => {
  const now = Date.parse("2026-08-21T00:00:00Z");
  for (const [retryAfter, expected] of [
    ["Fri, 21 Aug 2026 00:00:01 GMT", 1000],
    ["not-a-date", 250],
  ] as const) {
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
          sleep: async (ms) => void delays.push(ms),
        },
      ),
    );
    assert.deepEqual(delays, [expected]);
  }
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
