import assert from "node:assert/strict";
import test from "node:test";
import { HELP, parseCli } from "../src/cli.js";

test("parseCli defaults to stdio", () => {
  assert.deepEqual(parseCli([]), {
    transport: "stdio",
    host: "127.0.0.1",
    port: 3_000,
    path: "/mcp",
    help: false,
  });
});

test("parseCli accepts HTTP transport selectors", () => {
  assert.equal(parseCli(["--http"]).transport, "http");
  assert.equal(parseCli(["--transport=http"]).transport, "http");
  assert.equal(parseCli(["--transport", "http"]).transport, "http");
});

test("parseCli accepts HTTP settings", () => {
  assert.deepEqual(
    parseCli([
      "--http",
      "--host",
      "localhost",
      "--port=4000",
      "--path",
      "/chess",
    ]),
    {
      transport: "http",
      host: "localhost",
      port: 4_000,
      path: "/chess",
      help: false,
    },
  );
});

test("parseCli accepts port zero for an ephemeral HTTP listener", () => {
  assert.equal(parseCli(["--http", "--port", "0"]).port, 0);
});

test("parseCli canonicalizes and validates the bind host", () => {
  assert.equal(parseCli(["--http", "--host", "127.1"]).host, "127.0.0.1");
  assert.equal(
    parseCli(["--http", "--host", "0:0:0:0:0:0:0:1"]).host,
    "[::1]",
  );
  for (const host of [
    "example.com:3000",
    "user@example.com",
    "[::1]:3000",
    "evil.com/path",
    " ",
  ]) {
    assert.throws(
      () => parseCli(["--http", "--host", host]),
      /HTTP hostnames must be non-empty hostnames/,
    );
  }
});

test("parseCli exposes help", () => {
  assert.match(HELP, /Usage: llm-chess-mcp/);
  assert.equal(parseCli(["--help"]).help, true);
  assert.equal(parseCli(["-h"]).help, true);
  assert.equal(parseCli(["--unknown", "--help", "--port", "bad"]).help, true);
});

test("parseCli rejects unknown and valueless options", () => {
  assert.throws(() => parseCli(["--unknown"]), /unknown option: --unknown/);
  assert.throws(() => parseCli(["--transport"]), /--transport requires a value/);
  assert.throws(() => parseCli(["--http=1"]), /--http takes no value/);
  assert.throws(() => parseCli(["--http", "--allowed-host", "example.com"]), /unknown option: --allowed-host/);
  assert.throws(() => parseCli(["--http", "--allowed-host=example.com"]), /unknown option: --allowed-host/);
});

test("parseCli rejects invalid ports and paths", () => {
  for (const port of ["abc", "65536"]) {
    assert.throws(() => parseCli(["--http", "--port", port]), /--port must be/);
  }

  for (const path of [
    "mcp",
    "//mcp",
    "/chess/../mcp",
    "/chess/%2e%2e/mcp",
    "/mcp?debug=1",
    "/mcp#fragment",
  ]) {
    assert.throws(() => parseCli(["--http", "--path", path]), /--path must be an absolute URL path/);
  }
});

test("parseCli rejects HTTP settings with stdio transport", () => {
  for (const args of [
    ["--host", "localhost"],
    ["--port", "4000"],
    ["--path", "/chess"],
    ["--transport=stdio", "--host", "localhost"],
  ]) {
    assert.throws(() => parseCli(args), /HTTP options require --transport http/);
  }
});

test("parseCli accepts wildcard HTTP bindings without a host allowlist", () => {
  for (const host of [
    "0.0.0.0",
    "::",
    "[::]",
    "0:0:0:0:0:0:0:0",
    "[0:0:0:0:0:0:0:0]",
    "0x0",
  ]) {
    assert.doesNotThrow(() => parseCli(["--http", "--host", host]));
  }
});

test("parseCli accepts bearer file, proxy, and rate-limit settings", () => {
  assert.deepEqual(
    parseCli([
      "--http",
      "--bearer-file",
      "/etc/llm-chess/bearers",
      "--trusted-proxy=10.0.0.0/8",
      "--trusted-proxy",
      "192.168.0.0/16",
      "--rate-limit-ip-request-per-minute",
      "90",
      "--rate-limit-ip-request-burst=12",
      "--rate-limit-bearer-work-per-minute",
      "20",
    ]),
    {
      transport: "http",
      host: "127.0.0.1",
      port: 3_000,
      path: "/mcp",
      bearerFile: "/etc/llm-chess/bearers",
      trustedProxies: ["10.0.0.0/8", "192.168.0.0/16"],
      rateLimits: {
        request: { ip: { ratePerMinute: 90, burst: 12 } },
        work: { bearer: { ratePerMinute: 20, burst: 2 } },
      },
      help: false,
    },
  );
});

test("parseCli preserves the other rate-limit default when overriding one field", () => {
  const burst = parseCli([
    "--http",
    "--rate-limit-ip-request-burst",
    "7",
  ]).rateLimits?.request?.ip;
  assert.deepEqual(burst, { ratePerMinute: 60, burst: 7 });

  const rate = parseCli([
    "--http",
    "--rate-limit-ip-request-per-minute",
    "90",
  ]).rateLimits?.request?.ip;
  assert.deepEqual(rate, { ratePerMinute: 90, burst: 10 });

  const first = parseCli([
    "--http",
    "--rate-limit-ip-request-burst",
    "7",
  ]).rateLimits?.request?.ip;
  const second = parseCli([
    "--http",
    "--rate-limit-ip-request-burst",
    "8",
  ]).rateLimits?.request?.ip;
  assert.deepEqual(first, { ratePerMinute: 60, burst: 7 });
  assert.deepEqual(second, { ratePerMinute: 60, burst: 8 });
});

test("parseCli accepts manual TLS and defaults its port to 443", () => {
  assert.deepEqual(
    parseCli(["--http", "--tls-cert", "cert.pem", "--tls-key=key.pem"]),
    {
      transport: "http",
      host: "127.0.0.1",
      port: 443,
      path: "/mcp",
      tls: { mode: "manual", certPath: "cert.pem", keyPath: "key.pem" },
      help: false,
    },
  );
  assert.equal(parseCli(["--http", "--port", "9443", "--tls-cert", "c", "--tls-key", "k"]).port, 9443);
});

test("parseCli validates ACME settings", () => {
  assert.deepEqual(
    parseCli([
      "--http",
      "--acme-domain",
      "chess.example",
      "--acme-email",
      "ops@example.com",
      "--acme-storage",
      "/var/lib/llm-chess/acme",
      "--acme-agree-tos",
      "--acme-staging",
    ]),
    {
      transport: "http",
      host: "127.0.0.1",
      port: 443,
      path: "/mcp",
      tls: {
        mode: "acme",
        domain: "chess.example",
        email: "ops@example.com",
        storageDir: "/var/lib/llm-chess/acme",
        termsOfServiceAgreed: true,
        directoryUrl: "https://acme-staging-v02.api.letsencrypt.org/directory",
        challengePort: 80,
      },
      help: false,
    },
  );
  assert.throws(
    () => parseCli(["--http", "--tls-cert", "cert.pem"]),
    /--tls-cert and --tls-key must be provided together/,
  );
  assert.throws(
    () => parseCli(["--http", "--acme-domain", "chess.example", "--acme-email", "ops@example.com"]),
    /ACME requires --acme-domain, --acme-email, and --acme-storage/,
  );
  assert.throws(
    () => parseCli(["--http", "--acme-domain", "127.0.0.1", "--acme-email", "ops@example.com", "--acme-storage", "/tmp/acme", "--acme-agree-tos"]),
    /--acme-domain must be a hostname/,
  );
});

test("parseCli accepts and canonicalizes the ACME challenge host", () => {
  assert.deepEqual(
    parseCli([
      "--http",
      "--acme-domain", "chess.example",
      "--acme-email", "ops@example.com",
      "--acme-storage", "/var/lib/llm-chess/acme",
      "--acme-agree-tos",
      "--acme-challenge-host", "0:0:0:0:0:0:0:1",
    ]).tls,
    {
      mode: "acme",
      domain: "chess.example",
      email: "ops@example.com",
      storageDir: "/var/lib/llm-chess/acme",
      termsOfServiceAgreed: true,
      challengePort: 80,
      challengeHost: "::1",
    },
  );
  assert.throws(
    () => parseCli([
      "--http", "--acme-domain", "chess.example", "--acme-email", "ops@example.com",
      "--acme-storage", "/tmp/acme", "--acme-agree-tos", "--acme-challenge-host", "bad/path",
    ]),
    /--acme-challenge-host must be a hostname/,
  );
});

test("parseCli rejects an ACME challenge port equal to the HTTPS port", () => {
  assert.throws(
    () => parseCli([
      "--http", "--port", "8443", "--acme-domain", "chess.example", "--acme-email", "ops@example.com",
      "--acme-storage", "/tmp/acme", "--acme-agree-tos", "--acme-challenge-port", "8443",
    ]),
    /HTTPS listen port and ACME challenge port must differ/,
  );
});

test("parseCli rejects malformed trusted proxy addresses", () => {
  for (const value of ["not-an-ip", "127.0.0.1/", "::1/", "127.0.0.1/0x0", "::1/0e0"]) {
    assert.throws(
      () => parseCli(["--http", "--trusted-proxy", value]),
      /--trusted-proxy must contain valid IP addresses or CIDRs/,
    );
  }
});
