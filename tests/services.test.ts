import assert from "node:assert/strict";
import test from "node:test";
import {
  createAppServicesLeaseManager,
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
