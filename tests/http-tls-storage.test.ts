import assert from "node:assert/strict";
import { chmod, mkdtemp, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcmeStorageLock } from "../src/http-tls-storage.js";

test("ACME locks reject contention and can be released repeatedly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acme-lock-"));
  const lock = new AcmeStorageLock();
  const other = new AcmeStorageLock();
  try {
    await lock.acquire(dir);
    assert.equal(lock.acquired, true);
    await assert.rejects(other.acquire(dir), /locked by another process/);
    await lock.release();
    await lock.release();
    assert.equal(lock.acquired, false);
    await other.acquire(dir);
  } finally {
    await lock.release();
    await other.release();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const mode of [0o500, 0o000]) test(`ACME lock release reports permission failures (${mode.toString(8)}) without retaining stale ownership`, {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "acme-lock-permissions-"));
  const lock = new AcmeStorageLock();
  try {
    await lock.acquire(dir);
    await chmod(dir, mode);
    await assert.rejects(lock.release(), { code: "EACCES" });
    assert.equal(lock.acquired, false);
    await chmod(dir, 0o700);
    await stat(join(dir, "issue.lock"));
    await assert.rejects(new AcmeStorageLock().acquire(dir), /locked by another process/);
    await unlink(join(dir, "issue.lock"));
    await writeFile(join(dir, "issue.lock"), "replacement", { mode: 0o600 });
    await lock.release();
    assert.equal(await readFile(join(dir, "issue.lock"), "utf8"), "replacement");
    await unlink(join(dir, "issue.lock"));
    await lock.acquire(dir);
  } finally {
    await chmod(dir, 0o700);
    await lock.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ACME lock release tolerates a missing file and preserves a replacement lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acme-lock-identity-"));
  const path = join(dir, "issue.lock");
  const lock = new AcmeStorageLock();
  try {
    await lock.acquire(dir);
    await unlink(path);
    await lock.release();
    await lock.acquire(dir);
    await rename(path, join(dir, "old.lock"));
    await writeFile(path, "replacement", { mode: 0o600 });
    await lock.release();
    assert.equal(await readFile(path, "utf8"), "replacement");
    assert.equal(lock.acquired, false);
  } finally {
    await lock.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ACME lock creation does not misreport filesystem errors as contention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acme-lock-errors-"));
  try {
    await assert.rejects(new AcmeStorageLock().acquire(join(dir, "missing")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const failCleanup of [false, true]) test(`ACME lock initialization preserves write and cleanup errors (cleanup=${failCleanup})`, {
  skip: failCleanup && (process.platform === "win32" || process.getuid?.() === 0),
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acme-lock-initialize-"));
  const probe = await open(join(dir, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const primary = Object.assign(new Error("write failed"), { code: "ENOSPC" });
  const closeError = Object.assign(new Error("close failed"), { code: "EIO" });
  let closed = false;
  const writeMock = t.mock.method(prototype, "writeFile", async function (this: FileHandle) {
    const close = this.close;
    t.mock.method(this, "close", async () => {
      await close.call(this);
      closed = true;
      if (failCleanup) throw closeError;
    });
    if (failCleanup) await chmod(dir, 0o500);
    throw primary;
  });
  const lock = new AcmeStorageLock();
  try {
    await assert.rejects(lock.acquire(dir), (error: unknown) => {
      if (failCleanup) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], primary);
        const cleanup = error.errors[1] as AggregateError;
        assert.ok(cleanup instanceof AggregateError);
        assert.equal((cleanup.errors[0] as NodeJS.ErrnoException).code, "EACCES");
        assert.equal(cleanup.errors[1], closeError);
      } else assert.equal(error, primary);
      return true;
    });
    assert.equal(closed, true);
    assert.equal(lock.acquired, false);
    if (failCleanup) await stat(join(dir, "issue.lock"));
    else await assert.rejects(stat(join(dir, "issue.lock")), { code: "ENOENT" });
  } finally {
    writeMock.mock.restore();
    if (failCleanup) await chmod(dir, 0o700);
    await lock.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed lock initialization never removes a replacement file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acme-lock-replaced-"));
  const path = join(dir, "issue.lock");
  const probe = await open(join(dir, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const originalWrite = prototype.writeFile;
  const primary = new Error("write failed after replacement");
  const writeMock = t.mock.method(prototype, "writeFile", async () => {
    await rename(path, join(dir, "original.lock"));
    const replacement = await open(path, "wx");
    try { await originalWrite.call(replacement, "replacement"); }
    finally { await replacement.close(); }
    throw primary;
  });
  try {
    await assert.rejects(new AcmeStorageLock().acquire(dir), (error: unknown) => error === primary);
    assert.equal(await readFile(path, "utf8"), "replacement");
  } finally {
    writeMock.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed lock identity lookup is reported without unlinking an unverified file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "acme-lock-stat-"));
  const path = join(dir, "issue.lock");
  const probe = await open(join(dir, "probe"), "wx");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const failure = Object.assign(new Error("stat failed"), { code: "EIO" });
  const statMock = t.mock.method(prototype, "stat", async () => { throw failure; });
  try {
    const lock = new AcmeStorageLock();
    await assert.rejects(lock.acquire(dir), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure, failure]);
      return true;
    });
    assert.equal(lock.acquired, false);
    await stat(path);
  } finally {
    statMock.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});
