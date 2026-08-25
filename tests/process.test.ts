import assert from "node:assert/strict";
import test from "node:test";
import {
  E2E_MAIA3_MODEL,
  E2E_STOCKFISH_FLAVOR,
  childEnv,
} from "./support/process.js";

test("childEnv removes credentials and pins bundled engine settings", () => {
  const env = childEnv({
    PATH: "/usr/bin",
    LICHESS_TOKEN: "secret",
    MAIA3_MODEL: "23m",
    STOCKFISH_FLAVOR: "full",
    EMPTY: undefined,
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin",
    LICHESS_TOKEN: "",
    MAIA3_MODEL: E2E_MAIA3_MODEL,
    STOCKFISH_FLAVOR: E2E_STOCKFISH_FLAVOR,
  });
});
