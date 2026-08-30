import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import test from "node:test";
import { Chess } from "chess.js";
import { stockfish } from "../src/engines/stockfish.js";
import {
  createAppServicesLeaseManager,
  defaultAppServices,
  type AppServices,
} from "../src/services.js";

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
