import assert from "node:assert/strict";
import test from "node:test";
import { HttpSessionRegistry } from "../src/http-sessions.js";

type Session = {
  lastUsedAt: number;
  activeRequests: number;
};

function session(lastUsedAt = 0): Session {
  return { lastUsedAt, activeRequests: 0 };
}

test("HTTP session reservations are idempotent and capacity-bound", async () => {
  const registry = new HttpSessionRegistry<Session>(1, () => 0);
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
  let now = 0;
  const registry = new HttpSessionRegistry<Session>(2, () => now);
  const reservation = registry.tryReserve();
  assert.ok(reservation);
  const active = session();
  reservation.attach(active);
  reservation.initialized("active");

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = registry.withActive(active, () => blocked);
  let stopped = 0;
  now = 1_000;
  await registry.reap(1, async () => {
    stopped += 1;
  });
  assert.equal(stopped, 0);

  release();
  await running;
  now += 1;
  await registry.reap(1, async () => {
    stopped += 1;
  });
  assert.equal(stopped, 1);
  reservation.finish();
});

test("HTTP session expiry ignores wall-clock jumps", async (t) => {
  let wallTime = 1_000;
  let now = 0;
  t.mock.method(Date, "now", () => wallTime);
  const registry = new HttpSessionRegistry<Session>(1, () => now);
  const reservation = registry.tryReserve();
  assert.ok(reservation);
  reservation.attach(session());
  reservation.initialized("session");

  let stopped = 0;
  wallTime += 60 * 60 * 1_000;
  now = 9;
  await registry.reap(10, async () => {
    stopped += 1;
  });
  assert.equal(stopped, 0);

  wallTime = 0;
  now = 10;
  await registry.reap(10, async () => {
    stopped += 1;
  });
  assert.equal(stopped, 1);
  reservation.finish();
});

test("HTTP session clock failures do not poison later reaping", async () => {
  let now = 100;
  const registry = new HttpSessionRegistry<Session>(1, () => now);
  const reservation = registry.tryReserve();
  assert.ok(reservation);
  reservation.attach(session());
  reservation.initialized("session");

  now = 99;
  await assert.rejects(registry.reap(10, async () => {}), RangeError);
  assert.equal(registry.size, 1);

  let stopped = 0;
  now = 110;
  await registry.reap(10, async () => {
    stopped += 1;
  });
  assert.equal(stopped, 1);
  reservation.finish();
});
