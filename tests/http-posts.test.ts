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

test("HTTP body admission preempts an overflow body control lease", () => {
  const admission = new HttpBodyAdmission(1, 1);
  const primary = admission.acquire();
  const control = admission.acquire();
  const next = admission.acquire();

  assert.equal(primary.preemptSignal.aborted, false);
  assert.equal(control.preemptSignal.aborted, true);
  assert.equal(next.preemptSignal.aborted, false);
  primary.release();
  control.release();
  next.release();
});
