import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalHttpHostname,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  isCanonicalHttpPath,
  isWildcardHttpBindHost,
  resolveHttpConfig,
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
  assert.equal(isWildcardHttpBindHost("[::ffff:0.0.0.0]"), true);
  assert.equal(isWildcardHttpBindHost("0:0:0:0:0:ffff:0:0"), true);
  assert.equal(isWildcardHttpBindHost("[::ffff:127.0.0.1]"), false);
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

test("HTTP configuration resolves listener and resource settings together", () => {
  const config = resolveHttpConfig({
    host: "127.1",
    port: 0,
    requestTimeoutMs: 123,
  });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.listenHost, "127.0.0.1");
  assert.equal(config.port, 0);
  assert.equal(config.path, "/mcp");
  assert.deepEqual(config.allowedHosts, ["localhost", "127.0.0.1", "[::1]"]);
  assert.equal(config.limits.bodyTimeoutMs, 123);
});
