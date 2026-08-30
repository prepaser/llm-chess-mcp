import assert from "node:assert/strict";
import test from "node:test";
import { HttpBodyAdmission, HttpPostAdmission } from "../src/http-posts.js";

test("HTTP POST admission releases each lease once", () => {
  const admission = new HttpPostAdmission<{ activePosts: number }>(1, 1);
  const first = { activePosts: 0 };
  const second = { activePosts: 0 };
  const lease = admission.tryAcquire(first);
  assert.equal(typeof lease, "object");
  assert.equal(first.activePosts, 1);
  assert.equal(admission.tryAcquire(first), 429);
  assert.equal(admission.tryAcquire(second), 503);

  if (typeof lease === "object") {
    lease.release();
    lease.release();
  }
  assert.equal(first.activePosts, 0);

  const next = admission.tryAcquire(second);
  assert.equal(typeof next, "object");
  if (typeof next === "object") next.release();
  assert.equal(second.activePosts, 0);
});

test("HTTP body admission bounds full and probe leases independently", () => {
  const admission = new HttpBodyAdmission(1, 2);
  const full = admission.acquire();
  const firstProbe = admission.acquire();
  const secondProbe = admission.acquire();

  assert.equal(full?.kind, "full");
  assert.equal(firstProbe?.kind, "probe");
  assert.equal(secondProbe?.kind, "probe");
  assert.equal(admission.acquire(), undefined);
  firstProbe?.release();
  assert.equal(admission.acquire()?.kind, "probe");
  full?.release();
});
