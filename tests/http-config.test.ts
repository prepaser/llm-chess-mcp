import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalHttpHostname,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  isCanonicalHttpPath,
  isWildcardHttpBindHost,
} from "../src/http-config.js";

test("HTTP configuration defaults and shared address rules stay stable", () => {
  assert.equal(DEFAULT_HTTP_HOST, "127.0.0.1");
  assert.equal(DEFAULT_HTTP_PORT, 3_000);
  assert.equal(DEFAULT_HTTP_PATH, "/mcp");
  assert.equal(isWildcardHttpBindHost("0.0.0.0"), true);
  assert.equal(isWildcardHttpBindHost("0x0"), true);
  assert.equal(isWildcardHttpBindHost("[::]"), true);
  assert.equal(isWildcardHttpBindHost("[0:0:0:0:0:0:0:0]"), true);
  assert.equal(isWildcardHttpBindHost("0:0:0:0:0:0:0:0"), true);
  assert.equal(isWildcardHttpBindHost("127.0.0.1"), false);

  assert.equal(canonicalHttpHostname("EXAMPLE.COM"), "example.com");
  assert.equal(canonicalHttpHostname("127.1"), "127.0.0.1");
  assert.equal(canonicalHttpHostname("0:0:0:0:0:0:0:1"), "[::1]");
  for (const host of [
    "example.com:3000",
    "user@example.com",
    "[::1]:3000",
    "evil\\path",
  ]) {
    assert.equal(canonicalHttpHostname(host), null);
  }

  for (const path of ["/mcp", "/chess"]) assert.equal(isCanonicalHttpPath(path), true);
  for (const path of ["mcp", "//mcp", "/chess/../mcp", "/mcp?debug=1", "/mcp#x"]) {
    assert.equal(isCanonicalHttpPath(path), false);
  }
});
