import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalHttpHostname,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  isCanonicalHttpPath,
  resolveHttpConfig,
} from "../src/http-config.js";

test("HTTP configuration defaults and shared address rules stay stable", () => {
  assert.equal(DEFAULT_HTTP_HOST, "127.0.0.1");
  assert.equal(DEFAULT_HTTP_PORT, 3_000);
  assert.equal(DEFAULT_HTTP_PATH, "/mcp");
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
  assert.equal(config.limits.bodyTimeoutMs, 123);
});

test("HTTP configuration accepts wildcard listener hosts", () => {
  assert.equal(resolveHttpConfig({ host: "0.0.0.0" }).listenHost, "0.0.0.0");
  assert.equal(resolveHttpConfig({ host: "::" }).listenHost, "::");
});

test("TLS selects HTTPS defaults without changing explicit ports or HTTP limits", () => {
  const tls = { mode: "manual", certPath: "cert.pem", keyPath: "key.pem" } as const;
  assert.equal(resolveHttpConfig({ tls }).port, 443);
  assert.equal(resolveHttpConfig({ tls, port: 0 }).port, 0);
  assert.equal(resolveHttpConfig({ tls: { mode: "off" } }).port, 3_000);
  assert.deepEqual(resolveHttpConfig({ tls, auth: { bearer: "token" } }).limits, resolveHttpConfig({}).limits);
});

test("resolved ACME config follows the application bind host by default", () => {
  const config = resolveHttpConfig({
    host: "::",
    tls: {
      mode: "acme",
      domain: "chess.example",
      email: "ops@example.com",
      storageDir: "/var/lib/llm-chess/acme",
      termsOfServiceAgreed: true,
    },
  });
  assert.equal(config.tls.mode, "acme");
  if (config.tls.mode === "acme") assert.equal(config.tls.challengeHost, "::");
});

test("HTTP configuration rejects fixed ACME port collisions", () => {
  assert.throws(
    () => resolveHttpConfig({
      port: 8443,
      tls: {
        mode: "acme",
        domain: "chess.example",
        email: "ops@example.com",
        storageDir: "/var/lib/llm-chess/acme",
        termsOfServiceAgreed: true,
        challengePort: 8443,
      },
    }),
    /HTTPS listen port and ACME challenge port must differ/,
  );
});
