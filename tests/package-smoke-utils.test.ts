import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const {
  cleanupPackageSmokeWorkspace,
  formatPackageSmokeFailure,
  isStorageCapacityError,
  limitText,
  storageCapacityGuidance,
  writePackageSmokeDiagnostic,
} = await import(new URL("../scripts/package-smoke-utils.mjs", import.meta.url).href);

test("package smoke preserves bounded npm logs outside its disposable workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "smoke-diagnostic-"));
  try {
    const workspace = join(root, "temporary install");
    const logs = join(workspace, "npm-cache", "_logs");
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "npm-debug.log"), `start\n${"x".repeat(100_000)}\nlast npm error`);
    const report = await writePackageSmokeDiagnostic({
      error: new Error("Unknown system error -122: write"), workspace,
      tmpRoot: root, repoRoot: root, logRoot: join(workspace, "would-be-deleted"),
    });
    assert.equal(typeof report, "string");
    await cleanupPackageSmokeWorkspace(workspace);
    const contents = await readFile(report, "utf8");
    assert.match(contents, /PACKAGE_SMOKE_TMPDIR/);
    assert.match(contents, /last npm error/);
    assert.ok(contents.length < 65_600);
    if (process.platform !== "win32") assert.equal((await stat(report)).mode & 0o777, 0o600);
    const inaccessible = join(root, "not-a-directory");
    await writeFile(inaccessible, "file");
    assert.equal(await writePackageSmokeDiagnostic({ error: new Error("original"), repoRoot: root, logRoot: inaccessible }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package smoke cleanup does not mask a primary failure", async () => {
  const primary = new Error("install failed");
  const cleanup = new Error("cleanup failed");
  const result = await cleanupPackageSmokeWorkspace("/workspace", primary, async () => {
    throw cleanup;
  });
  assert.equal(result, cleanup);
  await assert.rejects(
    cleanupPackageSmokeWorkspace("/workspace", undefined, async () => {
      throw cleanup;
    }),
    (error: unknown) => error === cleanup,
  );
});

test("package smoke bounds diagnostic text", () => {
  const value = limitText("x".repeat(100), 32);
  assert.ok(value.length <= 32 + "\n[…truncated…]\n".length);
  assert.match(value, /truncated/);
});

test("package smoke detects quota failures and gives tmpdir guidance", () => {
  const error = Object.assign(new Error("write failed"), { code: "EDQUOT", stderr: "npm log" });
  assert.equal(isStorageCapacityError(error), true);
  assert.equal(isStorageCapacityError(new Error("Unknown system error -122: write")), true);
  assert.match(storageCapacityGuidance(error, "/tmp"), /PACKAGE_SMOKE_TMPDIR/);
  assert.equal(isStorageCapacityError(new Error("engine failed")), false);
});

test("package smoke failure text preserves command output", () => {
  const error = Object.assign(new Error("install failed"), {
    code: 1,
    cmd: "npm install",
    stdout: "stdout detail",
    stderr: "stderr detail",
  });
  const result = formatPackageSmokeFailure({
    error,
    workspace: "/tmp/workspace",
    tmpRoot: "/tmp",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  assert.match(result, /stdout detail/);
  assert.match(result, /stderr detail/);
  assert.match(result, /2026-01-01/);
});
