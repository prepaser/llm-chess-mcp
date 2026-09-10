import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertStockfishVersion,
  readStockfishConfig,
  resolveConfiguredStockfishFlavor,
  resolveStockfishFlavor,
  validateStockfishFlavor,
  validateStockfishVersion,
} from "../src/engines/stockfish-config.js";

test("validates stable Stockfish versions and flavors", () => {
  assert.equal(validateStockfishVersion("18.0.8"), "18.0.8");
  assert.equal(validateStockfishFlavor("SINGLE-LITE"), "single-lite");
  for (const value of ["18", "18.0", "18.0.8-beta", "^18.0.8", "18.0.08"]) {
    assert.throws(() => validateStockfishVersion(value), /exact stable x\.y\.z/);
  }
  assert.throws(() => validateStockfishFlavor("unknown"), /one of/);
});

test("reads exact version and default flavor from package metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "llm-chess-stockfish-config-"));
  try {
    const path = join(root, "package.json");
    await writeFile(
      path,
      JSON.stringify({ dependencies: { stockfish: "18.0.8" }, stockfish: { flavor: "asm" } }),
    );
    assert.deepEqual(readStockfishConfig(path), { version: "18.0.8", flavor: "asm" });
    await writeFile(path, JSON.stringify({ dependencies: { stockfish: "18.0.8" } }));
    assert.throws(() => readStockfishConfig(path), /metadata is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves explicit, environment, and metadata flavor priority", () => {
  const metadata = { version: "18.0.8", flavor: "asm" as const };
  assert.equal(resolveConfiguredStockfishFlavor("full", "lite", metadata), "full");
  assert.equal(resolveConfiguredStockfishFlavor(undefined, "lite", metadata), "lite");
  assert.equal(resolveConfiguredStockfishFlavor(undefined, "", metadata), "asm");
  assert.equal(resolveConfiguredStockfishFlavor(undefined, undefined, undefined), "lite-single");
  assert.equal(resolveStockfishFlavor(""), "lite-single");
});

test("reports installed Stockfish version mismatches", () => {
  assert.doesNotThrow(() => assertStockfishVersion("18.0.8", "18.0.8"));
  assert.throws(
    () => assertStockfishVersion("18.0.8", "17.1.0", "/tmp/stockfish/package.json"),
    /version mismatch: package requires 18\.0\.8, but installed stockfish is 17\.1\.0/,
  );
});
