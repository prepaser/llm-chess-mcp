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
