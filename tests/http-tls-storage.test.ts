import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
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
