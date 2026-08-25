import assert from "node:assert/strict";
import test from "node:test";
import { HttpSessionRegistry } from "../src/http-sessions.js";

type Session = {
  lastUsedAt: number;
  activeRequests: number;
};

function session(lastUsedAt = Date.now()): Session {
  return { lastUsedAt, activeRequests: 0 };
}

test("HTTP session reservations are idempotent and capacity-bound", async () => {
  const registry = new HttpSessionRegistry<Session>(1);
  const reservation = registry.tryReserve();
  assert.ok(reservation);
  assert.equal(registry.tryReserve(), undefined);

  const active = session();
  reservation.initialized("first");
  reservation.attach(active);
  reservation.initialized("second");
  assert.equal(registry.size, 1);
  assert.equal(registry.get("first"), active);
  assert.equal(registry.get("second"), undefined);
  assert.equal(reservation.finish(), true);
  assert.equal(reservation.finish(), true);

  let stopped = 0;
  await registry.close("first", active, async () => {
    stopped += 1;
  });
  assert.equal(stopped, 1);
  assert.equal(registry.size, 0);

  const released = registry.tryReserve();
  assert.ok(released);
  assert.equal(released.finish(), false);
  assert.equal(released.finish(), false);
  const next = registry.tryReserve();
  assert.ok(next);
  next.finish();
});

test("HTTP session reaping ignores active requests", async () => {
  const registry = new HttpSessionRegistry<Session>(2);
  const reservation = registry.tryReserve();
  assert.ok(reservation);
  const active = session(Date.now() - 1_000);
  reservation.attach(active);
  reservation.initialized("active");

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = registry.withActive(active, () => blocked);
  let stopped = 0;
  await registry.reap(1, async () => {
    stopped += 1;
  });
  assert.equal(stopped, 0);

  release();
  await running;
  active.lastUsedAt = Date.now() - 1_000;
  await registry.reap(1, async () => {
    stopped += 1;
  });
  assert.equal(stopped, 1);
  reservation.finish();
});
