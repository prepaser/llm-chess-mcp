import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { Chess } from "chess.js";
import { stockfish } from "../src/engines/stockfish.js";
import { buildServer } from "../src/server.js";
import {
  createAppServicesLeaseManager,
  defaultAppServices,
  type AppServices,
} from "../src/services.js";

test("default server construction acquires its lease only after registration", (t) => {
  const registrationError = new Error("registration failed");
  const releaseError = new Error("release failed");
  let quitCalls = 0;
  const quit = defaultAppServices.quit;
  defaultAppServices.quit = () => {
    quitCalls += 1;
    return Promise.reject(releaseError);
  };
  t.after(() => {
    defaultAppServices.quit = quit;
  });
  t.mock.method(McpServer.prototype, "registerTool", () => {
    throw registrationError;
  });

  assert.throws(() => buildServer(), (error: unknown) => error === registrationError);
  assert.equal(quitCalls, 0);
});

test("service leases reject reacquisition during asynchronous teardown", async () => {
  let finishQuit!: () => void;
  let markQuitStarted!: () => void;
  let quitCalls = 0;
  const quitStarted = new Promise<void>((resolve) => {
    markQuitStarted = resolve;
  });
  const quitFinished = new Promise<void>((resolve) => {
    finishQuit = resolve;
  });
  const services = {
    async quit() {
      quitCalls += 1;
      if (quitCalls === 1) {
        markQuitStarted();
        await quitFinished;
      }
    },
  } as AppServices;
  const leases = createAppServicesLeaseManager(services);
  const first = leases.acquire();
  const releasing = first.release();
  await quitStarted;

  assert.throws(() => leases.acquire(), /application services are shutting down/);
  finishQuit();
  await releasing;

  const second = leases.acquire();
  await second.release();
  assert.equal(quitCalls, 2);
});

test("duplicate lease releases share teardown completion", async () => {
  let finishQuit!: () => void;
  let markQuitStarted!: () => void;
  const quitStarted = new Promise<void>((resolve) => {
    markQuitStarted = resolve;
  });
  const quitFinished = new Promise<void>((resolve) => {
    finishQuit = resolve;
  });
  const leases = createAppServicesLeaseManager({
    async quit() {
      markQuitStarted();
      await quitFinished;
    },
  } as AppServices);
  const lease = leases.acquire();
  const first = lease.release();
  await quitStarted;
  const duplicate = lease.release();

  assert.equal(duplicate, first);
  let settled = false;
  void duplicate.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  finishQuit();
  await duplicate;
  assert.equal(settled, true);
});

test("duplicate lease releases share teardown failure", async () => {
  const failure = new Error("quit failed");
  const leases = createAppServicesLeaseManager({
    quit: () => Promise.reject(failure),
  } as AppServices);
  const lease = leases.acquire();
  const first = lease.release();
  const duplicate = lease.release();

  assert.equal(duplicate, first);
  await assert.rejects(first, (error: unknown) => error === failure);
  await assert.rejects(duplicate, (error: unknown) => error === failure);
});

test("non-last lease releases remain immediately idempotent", async () => {
  let quitCalls = 0;
  const leases = createAppServicesLeaseManager({
    async quit() {
      quitCalls += 1;
    },
  } as AppServices);
  const first = leases.acquire();
  const last = leases.acquire();

  const released = first.release();
  assert.equal(first.release(), released);
  await released;
  assert.equal(quitCalls, 0);

  await last.release();
  assert.equal(quitCalls, 1);
});

test("cold default Maia calls snapshot positions before loading", async () => {
  const moduleUrl = new URL(
    `../src/services.ts?cold-snapshot=${Date.now()}`,
    import.meta.url,
  ).href;
  const { defaultAppServices: services } = (await import(
    moduleUrl
  )) as typeof import("../src/services.js");
  const chess = new Chess();
  const pending = services.humanMoveDistribution(chess, 1500, 1500, 1);
  chess.move("e4");

  try {
    const actual = await pending;
    const expected = await services.humanMoveDistribution(
      new Chess(),
      1500,
      1500,
      1,
    );
    assert.deepEqual(actual, expected);
  } finally {
    await services.quit();
  }
});

test("cold default shutdown fences same-tick Maia work and permits restart", async () => {
  const shuttingDown = defaultAppServices.quit();
  assert.equal(defaultAppServices.quit(), shuttingDown);
  await assert.rejects(
    defaultAppServices.humanMoveDistribution(new Chess(), 1500, 1500, 1),
    /application services are shutting down/,
  );
  await shuttingDown;

  assert.equal(
    (await defaultAppServices.humanMoveDistribution(new Chess(), 1500, 1500, 1))
      .length,
    1,
  );
  await defaultAppServices.quit();
});

test("default shutdown aborts and isolates active Explorer work", async () => {
  const previousToken = process.env.LICHESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.LICHESS_TOKEN = "token";
  let calls = 0;
  const requestSignals: AbortSignal[] = [];
  let resolveFirst: ((response: Response) => void) | undefined;
  let resolveCancelled: (() => void) | undefined;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    if (init?.signal) requestSignals.push(init.signal);
    if (calls > 1) {
      return new Response(
        JSON.stringify({ white: 0, draws: 0, black: 0, moves: [] }),
      );
    }
    return await new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
  };

  try {
    const active = defaultAppServices.openingExplorer(
      new Chess(),
      "lichess",
      [],
      [],
    );
    const outcome = active.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();
    const shuttingDown = defaultAppServices.quit();
    assert.match(String(await outcome), /application services are shutting down/);
    await shuttingDown;
    assert.equal(requestSignals[0]?.aborted, true);

    resolveFirst?.(
      new Response(
        new ReadableStream({
          cancel() {
            resolveCancelled?.();
          },
        }),
        { status: 429, headers: { "Retry-After": "60" } },
      ),
    );
    await cancelled;

    const restarted = await defaultAppServices.openingExplorer(
      new Chess(),
      "masters",
      [],
      [],
    );
    assert.deepEqual(restarted.moves, []);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.LICHESS_TOKEN;
    else process.env.LICHESS_TOKEN = previousToken;
    await defaultAppServices.quit();
  }
});

test("default shutdown rejects and drains active candidate computation", async () => {
  const previousToken = process.env.LICHESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.LICHESS_TOKEN = "token";
  const chess = new Chess();
  await Promise.all([
    defaultAppServices.analyze(chess.fen(), 1, 1),
    defaultAppServices.humanMoveDistribution(chess, 1500, 1500, 1),
  ]);
  let resolveExplorer: ((response: Response) => void) | undefined;
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  globalThis.fetch = async () => {
    resolveStarted?.();
    return await new Promise<Response>((resolve) => {
      resolveExplorer = resolve;
    });
  };

  try {
    const active = defaultAppServices.computeCandidates(
      new Chess(),
      1500,
      1,
      1,
      1,
      { db: "lichess", speeds: [], ratings: [] },
    );
    let settled = false;
    const outcome = active.then(
      () => null,
      (error: unknown) => error,
    ).finally(() => {
      settled = true;
    });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const shuttingDown = defaultAppServices.quit();
    await shuttingDown;

    assert.equal(settled, true);
    assert.match(String(await outcome), /application services are shutting down/);
    resolveExplorer?.(
      new Response(JSON.stringify({ white: 0, draws: 0, black: 0, moves: [] })),
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.LICHESS_TOKEN;
    else process.env.LICHESS_TOKEN = previousToken;
    await defaultAppServices.quit();
  }
});

test("default shutdown awaits Maia teardown before preserving a Stockfish failure", async () => {
  const active = defaultAppServices.humanMoveDistribution(
    new Chess(),
    1500,
    1500,
    1,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const failure = new Error("Stockfish teardown failed");
  const originalQuit = stockfish.quit;
  stockfish.quit = () => Promise.reject(failure);
  try {
    const shuttingDown = defaultAppServices.quit();
    await assert.rejects(
      active,
      /Maia3 inference cancelled by shutdown/,
    );
    await assert.rejects(shuttingDown, (error: unknown) => error === failure);
  } finally {
    stockfish.quit = originalQuit;
    await defaultAppServices.quit();
  }
});

test("delayed Maia teardown fences every default work entrypoint", async () => {
  const activeMaia = defaultAppServices
    .humanMoveDistribution(new Chess(), 1500, 1500, 1)
    .then(() => null, (error: unknown) => error);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const originalKill = ChildProcess.prototype.kill;
  const originalAnalyze = stockfish.analyze;
  let analyzeCalls = 0;
  ChildProcess.prototype.kill = function delayedKill(signal) {
    setTimeout(() => originalKill.call(this, signal), 100);
    return true;
  };
  stockfish.analyze = async () => {
    analyzeCalls += 1;
    return [];
  };

  try {
    const shuttingDown = defaultAppServices.quit();
    let settled = false;
    void shuttingDown.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false);

    await assert.rejects(
      defaultAppServices.analyze("fen", 1, 1),
      /application services are shutting down/,
    );
    await assert.rejects(
      defaultAppServices.openingExplorer(new Chess(), "lichess", [], []),
      /application services are shutting down/,
    );
    await assert.rejects(
      defaultAppServices.computeCandidates(new Chess(), 1500, 1, 1, 1),
      /application services are shutting down/,
    );
    assert.equal(analyzeCalls, 0);
    assert.match(String(await activeMaia), /cancelled by shutdown/);
    await shuttingDown;
  } finally {
    ChildProcess.prototype.kill = originalKill;
    stockfish.analyze = originalAnalyze;
    await defaultAppServices.quit();
  }
});
