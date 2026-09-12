import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnv } from "../src/env.js";

test("loadEnv accepts only application settings", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "llm-chess-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, ".env");
  writeFileSync(path, "MAIA3_MODEL=5m\nHTTP_BEARER='private-token'\nNODE_OPTIONS=--require=payload.js\n");
  const model = process.env.MAIA3_MODEL;
  const bearer = process.env.HTTP_BEARER;
  const nodeOptions = process.env.NODE_OPTIONS;

  delete process.env.MAIA3_MODEL;
  delete process.env.HTTP_BEARER;
  delete process.env.NODE_OPTIONS;
  try {
    loadEnv(path);
    assert.equal(process.env.MAIA3_MODEL, "5m");
    assert.equal(process.env.HTTP_BEARER, "private-token");
    assert.equal(process.env.NODE_OPTIONS, undefined);
  } finally {
    if (model === undefined) delete process.env.MAIA3_MODEL;
    else process.env.MAIA3_MODEL = model;
    if (bearer === undefined) delete process.env.HTTP_BEARER;
    else process.env.HTTP_BEARER = bearer;
    if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = nodeOptions;
  }
});

test("unreadable env configuration cannot silently disable authentication", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "llm-chess-env-error-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.doesNotThrow(() => loadEnv(join(dir, "missing")));
  assert.throws(() => loadEnv(dir), /failed to read environment configuration/);
});
