import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chess.js";
import {
  EXPLORER_ATTEMPT_TIMEOUT_MS,
  ExplorerError,
  LICHESS_RATINGS,
  LICHESS_SPEEDS,
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
  return { token: "secret-token", fetch, ...extra };
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
      options(fetch, { sleep: async (ms) => void delays.push(ms) }),
    );
    assert.equal(calls, 2);
    assert.deepEqual(delays, [expected]);
  }
});

test("does not retry after Retry-After exceeds the request budget", async () => {
  let calls = 0;
  const fetch: ExplorerFetch = async () => {
    calls += 1;
    return response(429, {}, { "Retry-After": "60" });
  };

  await assert.rejects(
    openingExplorer(new Chess(), "lichess", [], [], options(fetch)),
    expectKind("rate_limited"),
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
    assert.equal(calls, 2);
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
