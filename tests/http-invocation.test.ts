import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { ChessError } from "../src/errors.js";
import { withHttpWorkBudget } from "../src/http-invocation.js";
import { HttpSecurity } from "../src/http-rate-limit.js";
import { HttpWorkAdmission } from "../src/http-work.js";
import { withToolInvocation } from "../src/tool-invocation.js";
import { safeHandler, toolResult } from "../src/tool-result.js";

const subject = { ip: "192.0.2.1", bearer: "test-identity" };
const signal = new AbortController().signal;
const limited = (error: unknown): boolean => error instanceof ChessError && error.code === "RATE_LIMITED";

function setup(burst = 1, concurrent = 2) {
  const rate = { ratePerMinute: 1, burst };
  const security = new HttpSecurity({
    work: { global: rate, ip: rate, bearer: rate },
    maxWorkPerIp: concurrent,
    maxWorkPerBearer: concurrent,
  }, () => 0);
  const admission = new HttpWorkAdmission(4, 4);
  return { security, run: withHttpWorkBudget(admission.forSession(signal), security, () => subject) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("one tool invocation charges once across sequential work and retries", async () => {
  const { run, security } = setup();
  await withToolInvocation(async () => {
    await assert.rejects(run(signal, async () => { throw new Error("backend failure"); }), /backend failure/);
    for (let i = 0; i < 10; i++) assert.equal(await run(signal, async () => i), i);
  });
  assert.equal(security.check("work", subject).allowed, false);
  await assert.rejects(withToolInvocation(() => run(signal, async () => {})), limited);
});

test("parallel work shares one charge but retains per-service concurrency", async () => {
  const { run, security } = setup();
  const gate = deferred();
  await withToolInvocation(async () => {
    const first = run(signal, () => gate.promise);
    const second = run(signal, () => gate.promise);
    await assert.rejects(run(signal, async () => {}), /concurrency limit/);
    gate.resolve();
    await Promise.all([first, second]);
    await run(signal, async () => {});
  });
  assert.equal(security.check("work", subject).allowed, false);
});

test("concurrency rejection does not spend a new invocation's budget", async () => {
  const { run } = setup(2, 1);
  const gate = deferred();
  const first = withToolInvocation(() => run(signal, () => gate.promise));
  await assert.rejects(withToolInvocation(() => run(signal, async () => {})), /concurrency limit/);
  gate.resolve();
  await first;
  await withToolInvocation(() => run(signal, async () => {}));
  await assert.rejects(withToolInvocation(() => run(signal, async () => {})), limited);
});

test("independent concurrent invocations each consume a token", async () => {
  const { run } = setup(1, 2);
  const gate = deferred();
  const first = withToolInvocation(() => run(signal, () => gate.promise));
  await assert.rejects(withToolInvocation(() => run(signal, async () => {})), limited);
  gate.resolve();
  await first;
});

test("cancelled uncooperative work holds its lease until it settles", async () => {
  const { run } = setup(2, 1);
  const controller = new AbortController();
  const gate = deferred();
  const first = withToolInvocation(() => run(controller.signal, () => gate.promise));
  controller.abort(new Error("cancel test"));
  const cancelled = assert.rejects(first, /cancel test/);
  await assert.rejects(withToolInvocation(() => run(signal, async () => {})), /concurrency limit/);
  gate.resolve();
  await cancelled;
  await withToolInvocation(() => run(signal, async () => {}));
});

test("safeHandler establishes a fresh invocation only after valid input", async () => {
  const { run, security } = setup();
  const handler = safeHandler(z.object({ value: z.number() }), z.object({}), async () => {
    await run(signal, async () => {});
    await run(signal, async () => {});
    return toolResult({}, "ok");
  });
  assert.equal((await handler({ value: "invalid" } as never)).isError, true);
  assert.equal(security.check("work", subject).allowed, true);
  assert.notEqual((await handler({ value: 1 })).isError, true);
  const second = await handler({ value: 2 });
  assert.equal((second.structuredContent.error as { code: string }).code, "RATE_LIMITED");
});

test("missing invocation and pre-aborted work fail without consuming tokens", async () => {
  const { run, security } = setup();
  await assert.rejects(run(signal, async () => {}), /missing tool invocation/);
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  await assert.rejects(withToolInvocation(() => run(controller.signal, async () => {})), /already cancelled/);
  assert.equal(security.check("work", subject).allowed, true);
  await withToolInvocation(() => run(signal, async () => {}));
});
