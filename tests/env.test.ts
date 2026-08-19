import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnv } from "../src/env.js";

test("loadEnv accepts only application settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-chess-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, "MAIA3_MODEL=5m\nNODE_OPTIONS=--require=payload.js\n");
  const model = process.env.MAIA3_MODEL;
  const nodeOptions = process.env.NODE_OPTIONS;

  delete process.env.MAIA3_MODEL;
  delete process.env.NODE_OPTIONS;
  try {
    loadEnv(path);
    assert.equal(process.env.MAIA3_MODEL, "5m");
    assert.equal(process.env.NODE_OPTIONS, undefined);
  } finally {
    if (model === undefined) delete process.env.MAIA3_MODEL;
    else process.env.MAIA3_MODEL = model;
    if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = nodeOptions;
  }
});
