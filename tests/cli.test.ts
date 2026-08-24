import assert from "node:assert/strict";
import test from "node:test";
import { HELP, parseCli } from "../src/cli.js";

test("parseCli defaults to stdio", () => {
  assert.deepEqual(parseCli([]), {
    transport: "stdio",
    host: "127.0.0.1",
    port: 3_000,
    path: "/mcp",
    allowedHosts: [],
    help: false,
  });
});

test("parseCli accepts HTTP transport selectors", () => {
  assert.equal(parseCli(["--http"]).transport, "http");
  assert.equal(parseCli(["--transport=http"]).transport, "http");
  assert.equal(parseCli(["--transport", "http"]).transport, "http");
});

test("parseCli accepts HTTP settings and repeated allowed hosts", () => {
  assert.deepEqual(
    parseCli([
      "--http",
      "--host",
      "localhost",
      "--port=4000",
      "--path",
      "/chess",
      "--allowed-host",
      "example.com",
      "--allowed-host=localhost",
    ]),
    {
      transport: "http",
      host: "localhost",
      port: 4_000,
      path: "/chess",
      allowedHosts: ["example.com", "localhost"],
      help: false,
    },
  );
});

test("parseCli exposes help", () => {
  assert.match(HELP, /Usage: llm-chess-mcp/);
  assert.equal(parseCli(["--help"]).help, true);
  assert.equal(parseCli(["-h"]).help, true);
});

test("parseCli rejects unknown and valueless options", () => {
  assert.throws(() => parseCli(["--unknown"]), /unknown option: --unknown/);
  assert.throws(() => parseCli(["--transport"]), /--transport requires a value/);
  assert.throws(() => parseCli(["--http=1"]), /--http takes no value/);
  assert.throws(
    () => parseCli(["--http", "--allowed-host", "evil.com/path"]),
    /HTTP hostnames must be non-empty hostnames/,
  );
});

test("parseCli rejects invalid ports and paths", () => {
  for (const port of ["abc", "0", "65536"]) {
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
    ["--allowed-host", "example.com"],
    ["--transport=stdio", "--host", "localhost"],
  ]) {
    assert.throws(() => parseCli(args), /HTTP options require --transport http/);
  }
});

test("parseCli requires allowed hosts for wildcard HTTP bindings", () => {
  for (const host of ["0.0.0.0", "::", "[::]"]) {
    assert.throws(
      () => parseCli(["--http", "--host", host]),
      /wildcard HTTP binding requires at least one --allowed-host/,
    );
  }

  assert.deepEqual(parseCli(["--http", "--host", "0.0.0.0", "--allowed-host", "example.com"]), {
    transport: "http",
    host: "0.0.0.0",
    port: 3_000,
    path: "/mcp",
    allowedHosts: ["example.com"],
    help: false,
  });
});
