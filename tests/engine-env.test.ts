import assert from "node:assert/strict";
import test from "node:test";
import { engineChildEnv } from "../src/engine-env.js";

test("engineChildEnv removes credentials without mutating the source", () => {
  const source = {
    PATH: "/usr/bin",
    HTTP_BEARER: "bearer",
    http_bearer: "lowercase-bearer",
    LICHESS_TOKEN: "token",
    lichess_token: "lowercase-token",
    NODE_OPTIONS: "--trace-warnings",
  };

  assert.deepEqual(engineChildEnv(source), {
    PATH: "/usr/bin",
    NODE_OPTIONS: "--trace-warnings",
  });
  assert.equal(source.HTTP_BEARER, "bearer");
  assert.equal(source.LICHESS_TOKEN, "token");
});
