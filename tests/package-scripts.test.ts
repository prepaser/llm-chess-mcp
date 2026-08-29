import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("publishing runs the complete release gate", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  const scripts = manifest.scripts ?? {};

  assert.equal(scripts.prepublishOnly, "pnpm release:check");
  for (const command of [
    "pnpm test:package",
    "pnpm audit --prod",
    "npm pack --dry-run --ignore-scripts",
  ]) {
    assert.ok(scripts["release:check"]?.includes(command));
  }
});
