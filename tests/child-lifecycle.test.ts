import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { childLifecycle, cleanupChild } from "../scripts/child-lifecycle.mjs";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killResult = true;
  killError: Error | undefined;
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.killError) throw this.killError;
    return this.killResult;
  }
}

const immediateTimers = {
  setTimeout(callback: () => void): undefined {
    queueMicrotask(callback);
    return undefined;
  },
  clearTimeout(): void {},
};

test("child lifecycle observes child exit and spawn errors", async () => {
  const exited = new FakeChild();
  const lifecycle = childLifecycle(exited);
  exited.exitCode = 0;
  exited.emit("exit", 0, null);
  assert.deepEqual(await lifecycle.wait(1, "child"), [0, null]);

  const failed = new FakeChild();
  const failedLifecycle = childLifecycle(failed);
  const failure = new Error("spawn failed");
  failed.emit("error", failure);
  await assert.rejects(failedLifecycle.exited, (error: unknown) => error === failure);
});

test("child lifecycle bounds failed termination and preserves primary failures", async () => {
  const child = new FakeChild();
  child.killResult = false;
  const lifecycle = childLifecycle(child, immediateTimers);

  await assert.rejects(
    lifecycle.stop("SIGKILL", 1, "child"),
    /child could not be terminated/,
  );
  assert.deepEqual(child.signals, ["SIGKILL"]);

  const primary = new Error("primary failure");
  await assert.doesNotReject(
    cleanupChild(lifecycle, 1, "child", primary),
  );
});

test("child lifecycle tolerates a failed kill when the child exits", async () => {
  const child = new FakeChild();
  child.killError = new Error("EPERM");
  const lifecycle = childLifecycle(child);
  const stopped = lifecycle.stop("SIGKILL", 1_000, "child");
  child.exitCode = 0;
  child.emit("exit", 0, null);

  assert.deepEqual(await stopped, [0, null]);
});
