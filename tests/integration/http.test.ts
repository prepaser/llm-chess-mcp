import assert from "node:assert/strict";
import { Agent, createServer, request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { GameStore } from "../../src/games.js";
import { serveHttp } from "../../src/http.js";
import { buildServer } from "../../src/server.js";
import { defaultAppServices } from "../../src/services.js";
import type { AppServices } from "../../src/services.js";

type JsonObject = Record<string, unknown>;

type HttpResult = {
  status: number;
  body: string;
  retryAfter?: string;
  sessionId?: string;
};

type ConnectedClient = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

function nodeKeepAliveTimeoutBuffer(): number {
  const server = createServer();
  return "keepAliveTimeoutBuffer" in server &&
    typeof server.keepAliveTimeoutBuffer === "number"
    ? server.keepAliveTimeoutBuffer
    : 0;
}

function fakeServices(
  games: GameStore,
  overrides: Pick<Partial<AppServices>, "analyze"> = {},
): AppServices {
  return {
    games,
    analyze: overrides.analyze ?? (async () => []),
    quit: async () => {},
    humanMoveDistribution: async () => [],
    explorerEnabled: () => false,
    openingExplorer: async (_chess, db) => ({
      db,
      white: 0,
      draws: 0,
      black: 0,
      moves: [],
      opening: null,
    }),
    computeCandidates: async () => ({
      candidates: [],
      moveSensitivity: { level: "low", topMoveSpreadCp: null },
    }),
    rankByIntent: (candidates) => candidates,
  };
}

function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method, headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const retryAfter = res.headers["retry-after"];
        const sessionId = res.headers["mcp-session-id"];
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          ...(typeof retryAfter === "string" ? { retryAfter } : {}),
          ...(typeof sessionId === "string" ? { sessionId } : {}),
        });
      });
    });
    req.once("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function rawHttpRequest(url: string, path: string): Promise<HttpResult> {
  const endpoint = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: endpoint.hostname,
        port: endpoint.port,
        path,
        headers: { host: endpoint.host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function chunkedPost(url: string, chunks: readonly string[]): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      },
      (res) => {
        const body: Buffer[] = [];
        res.on("data", (chunk: Buffer) => body.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(body).toString() });
        });
      },
    );
    req.once("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

function abandonedPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): { destroy(): void } {
  const req = request(url, { method: "POST", headers }, (res) => res.resume());
  req.on("error", () => {});
  req.end(body);
  return { destroy: () => req.destroy() };
}

function partialPost(url: string): Promise<{ destroy(): void }> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const socket = connect(Number(endpoint.port), endpoint.hostname, () => {
      socket.write(
        [
          "POST /mcp HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: application/json",
          "Content-Length: 100",
          "",
          "{",
        ].join("\r\n"),
        () => resolve({ destroy: () => socket.destroy() }),
      );
    });
    socket.once("error", reject);
  });
}

function partialSessionPost(
  url: string,
  id: string,
): Promise<{ closed: Promise<void>; destroy(): void }> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    let ready = false;
    const socket = connect(Number(endpoint.port), endpoint.hostname, () => {
      socket.write(
        [
          "POST /mcp HTTP/1.1",
          "Host: 127.0.0.1",
          "Accept: application/json, text/event-stream",
          "Content-Type: application/json",
          `Mcp-Session-Id: ${id}`,
          "Mcp-Protocol-Version: 2025-11-25",
          "Content-Length: 100",
          "",
          "{",
        ].join("\r\n"),
        () => {
          ready = true;
          resolve({
            closed: new Promise((done) => socket.once("close", done)),
            destroy: () => socket.destroy(),
          });
        },
      );
    });
    socket.on("error", (error) => {
      if (!ready) reject(error);
    });
  });
}

function waitForConnectionClose(url: string, payload: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    let connected = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const armTimeout = (phase: string): void => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(new Error(`${label} ${phase} did not complete`)),
        10_000,
      );
    };
    const socket = connect(Number(endpoint.port), endpoint.hostname, () => {
      connected = true;
      socket.write(payload, () => armTimeout("server timeout"));
    });
    armTimeout("connection");
    socket.once("error", (error) => {
      if (!connected) finish(error);
    });
    socket.once("close", () => finish());
    socket.resume();
  });
}

function slowRejectedRequest(
  url: string,
  headers: readonly string[],
  label: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${label} did not close`)), 1_000);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString());
    };
    const socket = connect(Number(endpoint.port), endpoint.hostname, () => {
      socket.write(
        [
          "POST /mcp HTTP/1.1",
          ...headers,
          "Transfer-Encoding: chunked",
          "Content-Type: application/json",
          "Connection: keep-alive",
          "",
          "1",
          "{",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("close", () => finish());
  });
}

const INIT_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

function initializeBody(id = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "http-limit-tests", version: "1.0.0" },
    },
  });
}

function toolCallBody(id: string, gameId: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "position_analyze",
      arguments: { game_id: gameId, analysis_level: "fast" },
    },
  });
}

function object(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function string(value: unknown): string {
  if (typeof value !== "string") assert.fail("expected a string");
  return value;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for condition");
}

async function connectClient(http: { url: string }, name: string): Promise<ConnectedClient> {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(http.url));
  await client.connect(transport);
  return { client, transport };
}

async function createGame(client: Client): Promise<string> {
  return string(
    object((await client.callTool({ name: "create_game", arguments: {} })).structuredContent)
      .game_id,
  );
}

function blockingAnalysis(): {
  started: Promise<void>;
  analyze: () => Promise<never[]>;
  release(): void;
} {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    analyze: async () => {
      start();
      await blocked;
      return [];
    },
    release,
  };
}

function abortableAnalysis(): {
  started: Promise<void>;
  aborted: Promise<void>;
  analyze: AppServices["analyze"];
} {
  let start!: () => void;
  let abort!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    abort = resolve;
  });
  return {
    started,
    aborted,
    analyze: async (_fen, _depth, _multipv, signal) => {
      assert.ok(signal);
      start();
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            abort();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
}

function openSse(url: string, sessionId: string): Promise<{ close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
      },
    });
    req.once("error", reject);
    req.once("response", (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE request failed with ${res.statusCode}`));
        res.resume();
        return;
      }
      resolve({
        close: () =>
          new Promise((done) => {
            res.once("close", done);
            res.destroy();
          }),
      });
    });
    req.end();
  });
}

test("Streamable HTTP serves an isolated game session", async (t) => {
  const games = new GameStore({ createId: () => "http-game" });
  const http = await serveHttp({ port: 0 }, fakeServices(games));
  const client = new Client({ name: "http-integration-tests", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(http.url));
  t.after(async () => {
    await client.close();
    await http.close();
  });

  await client.connect(transport);
  assert.equal(http.sessionCount(), 1);
  assert.ok(transport.sessionId);

  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "create_game"));
  assert.ok(listed.tools.some((tool) => tool.name === "game_state"));

  const created = object(
    (await client.callTool({ name: "create_game", arguments: {} })).structuredContent,
  );
  const gameId = string(created.game_id);
  assert.equal(created.revision, 0);
  assert.deepEqual(games.listGames(), [gameId]);

  const state = object(
    (
      await client.callTool({
        name: "game_state",
        arguments: { game_id: gameId, include_ascii: true },
      })
    ).structuredContent,
  );
  assert.equal(state.game_id, gameId);
  assert.equal(state.revision, 0);
  assert.equal(state.turn, "w");
  assert.equal(typeof state.board, "string");

  await transport.terminateSession();
  await waitFor(() => http.sessionCount() === 0);
  assert.equal(transport.sessionId, undefined);
});

test("Streamable HTTP rejects invalid routing, sessions, and browser headers", async (t) => {
  const http = await serveHttp({ port: 0 }, fakeServices(new GameStore()));
  t.after(() => http.close());

  const wrongPath = await fetch(`${http.url}/wrong`);
  assert.equal(wrongPath.status, 404);

  const invalidSession = await httpRequest(http.url, {
    headers: { "mcp-session-id": "missing" },
  });
  assert.equal(invalidSession.status, 404);
  assert.match(invalidSession.body, /MCP session not found/);

  const rejectedHost = await httpRequest(http.url, { headers: { host: "attacker.example" } });
  assert.equal(rejectedHost.status, 403);

  const rejectedOrigin = await httpRequest(http.url, {
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(rejectedOrigin.status, 403);
});

test("Streamable HTTP validates resource limits before listening", async () => {
  await assert.rejects(
    serveHttp(
      { host: "evil.com/path", port: 0, allowedHosts: ["localhost"] },
      fakeServices(new GameStore()),
    ),
    /invalid HTTP bind host/,
  );
  await assert.rejects(
    serveHttp({ port: 0, maxSessions: 0 }, fakeServices(new GameStore())),
    /maxSessions must be a positive integer/,
  );
  await assert.rejects(
    serveHttp(
      { port: 0, maxConcurrentPosts: 1, maxConcurrentPostsPerSession: 2 },
      fakeServices(new GameStore()),
    ),
    /maxConcurrentPostsPerSession must not exceed maxConcurrentPosts/,
  );
  await assert.rejects(
    serveHttp({ port: 0, bodyTimeoutMs: 0 }, fakeServices(new GameStore())),
    /bodyTimeoutMs must be a positive integer/,
  );
  await assert.rejects(
    serveHttp(
      { port: 0, bodyTimeoutMs: 1, requestTimeoutMs: 0 },
      fakeServices(new GameStore()),
    ),
    /requestTimeoutMs must be a positive integer/,
  );
  for (const options of [
    { sessionSweepIntervalMs: 2_147_483_648 },
    { headersTimeoutMs: 2_147_483_648 },
    { bodyTimeoutMs: 2_147_483_648 },
    { requestTimeoutMs: 2_147_483_648 },
    { socketTimeoutMs: 2_147_483_648 },
    { keepAliveTimeoutMs: 2_147_483_648 },
  ]) {
    await assert.rejects(
      serveHttp({ port: 0, ...options }, fakeServices(new GameStore())),
      /must be a safe integer between 1 and 2147483647/,
    );
  }
  const keepAliveTimeoutBuffer = nodeKeepAliveTimeoutBuffer();
  if (keepAliveTimeoutBuffer > 0) {
    await assert.rejects(
      serveHttp(
        { port: 0, keepAliveTimeoutMs: 2_147_483_647 },
        fakeServices(new GameStore()),
      ),
      new RegExp(
        `keepAliveTimeoutMs must not exceed ${2_147_483_647 - keepAliveTimeoutBuffer}`,
      ),
    );
  }

  const independentTimeouts = await serveHttp(
    { port: 0, headersTimeoutMs: 2, bodyTimeoutMs: 1 },
    fakeServices(new GameStore()),
  );
  await independentTimeouts.close();
});

test("Streamable HTTP keeps the largest safe keep-alive timer reusable", async (t) => {
  const keepAliveTimeoutMs =
    2_147_483_647 - nodeKeepAliveTimeoutBuffer();
  const warnings: Error[] = [];
  const onWarning = (warning: Error): void => {
    warnings.push(warning);
  };
  process.on("warning", onWarning);
  const http = await serveHttp(
    { port: 0, keepAliveTimeoutMs },
    fakeServices(new GameStore()),
  );
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => {
    process.off("warning", onWarning);
    agent.destroy();
    await http.close();
  });

  const send = (
    body: string,
    id?: string,
  ): Promise<{ reused: boolean; sessionId?: string; status: number }> =>
    new Promise((resolve, reject) => {
      const req = request(
        http.url,
        {
          agent,
          method: "POST",
          headers: {
            ...INIT_HEADERS,
            ...(id
              ? {
                  "mcp-protocol-version": "2025-11-25",
                  "mcp-session-id": id,
                }
              : {}),
          },
        },
        (res) => {
          res.resume();
          res.once("end", () => {
            const sessionId = res.headers["mcp-session-id"];
            resolve({
              reused: req.reusedSocket,
              status: res.statusCode ?? 0,
              ...(typeof sessionId === "string" ? { sessionId } : {}),
            });
          });
        },
      );
      req.once("error", reject);
      req.end(body);
    });

  const initialized = await send(initializeBody());
  assert.equal(initialized.status, 200);
  assert.ok(initialized.sessionId);
  assert.equal(initialized.reused, false);
  const notification = await send(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    initialized.sessionId,
  );
  assert.equal(notification.status, 202);
  assert.equal(notification.reused, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    warnings.some((warning) => warning.name === "TimeoutOverflowWarning"),
    false,
  );
});

test("Streamable HTTP closes shared default services after the last server", async (t) => {
  const quit = defaultAppServices.quit;
  let calls = 0;
  defaultAppServices.quit = async () => {
    calls += 1;
  };
  t.after(() => {
    defaultAppServices.quit = quit;
  });

  const first = await serveHttp({ port: 0 });
  const startingSecond = serveHttp({ port: 0 });
  await first.close();
  const second = await startingSecond;
  t.after(async () => {
    await first.close();
    await second.close();
  });

  assert.equal(calls, 0);

  const initialized = await httpRequest(second.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: initializeBody(),
  });
  assert.equal(initialized.status, 200);

  await second.close();
  assert.equal(calls, 1);
});

test("default services use one lease across programmatic and HTTP servers", async (t) => {
  const quit = defaultAppServices.quit;
  let calls = 0;
  defaultAppServices.quit = async () => {
    calls += 1;
  };
  t.after(() => {
    defaultAppServices.quit = quit;
  });

  const custom = buildServer(fakeServices(new GameStore()));
  const first = buildServer();
  const second = buildServer();
  const http = await serveHttp({ port: 0 });
  t.after(async () => {
    await custom.close();
    await first.close();
    await second.close();
    await http.close();
  });

  await custom.close();
  await first.close();
  await first.close();
  await http.close();
  assert.equal(calls, 0);

  await second.close();
  assert.equal(calls, 1);
});

test("Streamable HTTP rejects noncanonical endpoint paths", async (t) => {
  const http = await serveHttp({ port: 0 }, fakeServices(new GameStore()));
  t.after(() => http.close());

  for (const path of ["//mcp", "/chess/../mcp", "/chess/%2e%2e/mcp"]) {
    assert.equal((await rawHttpRequest(http.url, path)).status, 404, path);
  }
  for (const path of [
    "//mcp",
    "/chess/../mcp",
    "/chess/%2e%2e/mcp",
    "/mcp?debug=1",
    "/mcp#fragment",
  ]) {
    await assert.rejects(
      serveHttp({ port: 0, path }, fakeServices(new GameStore())),
      /invalid HTTP endpoint path/,
    );
  }
});

test("Streamable HTTP canonicalizes IPv4 shorthand bind hosts", async (t) => {
  const http = await serveHttp(
    { host: "127.1", port: 0, allowedHosts: ["127.1"] },
    fakeServices(new GameStore()),
  );
  t.after(() => http.close());

  assert.equal(http.host, "127.0.0.1");
  assert.match(http.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal((await httpRequest(http.url)).status, 400);
});

test("Streamable HTTP rejects allowed host paths", async () => {
  for (const host of [
    "evil.com/path",
    "example.com:3000",
    "user@example.com",
    "[::1]:3000",
    "evil\\path",
  ]) {
    await assert.rejects(
      serveHttp(
        { port: 0, allowedHosts: [host] },
        fakeServices(new GameStore()),
      ),
      /at least one allowed HTTP hostname is required/,
    );
  }
});

test("Streamable HTTP closes rejected slow request bodies", async (t) => {
  const http = await serveHttp(
    { port: 0, maxConnections: 1 },
    fakeServices(new GameStore()),
  );
  t.after(() => http.close());

  for (const [label, headers] of [
    ["invalid Host", ["Host: attacker.example"]],
    ["invalid Origin", ["Host: 127.0.0.1", "Origin: https://attacker.example"]],
  ] as const) {
    const response = await slowRejectedRequest(http.url, headers, label);
    assert.match(response, /^HTTP\/1\.1 403 /);
    assert.match(response, /connection: close/i);
    assert.match(response, /\"jsonrpc\":\"2\.0\"/);
  }

  const admitted = await httpRequest(http.url);
  assert.equal(admitted.status, 400);
});

test("Streamable HTTP bounds declared and chunked request bodies", async (t) => {
  const http = await serveHttp({ port: 0, maxRequestBodyBytes: 8 }, fakeServices(new GameStore()));
  t.after(() => http.close());

  const oversized = "x".repeat(9);
  const declared = await httpRequest(http.url, {
    method: "POST",
    headers: { "content-length": String(Buffer.byteLength(oversized)) },
    body: oversized,
  });
  assert.equal(declared.status, 413);
  assert.match(declared.body, /request body too large/);

  const chunked = await chunkedPost(http.url, ["1234", "56789"]);
  assert.equal(chunked.status, 413);
  assert.match(chunked.body, /request body too large/);

  const invalid = await httpRequest(http.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: "{",
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body, /invalid JSON request body/);

  const wrongContentType = await httpRequest(http.url, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{",
  });
  assert.equal(wrongContentType.status, 415);
  assert.match(wrongContentType.body, /Content-Type must be application\/json/);

  const encoded = await httpRequest(http.url, {
    method: "POST",
    headers: { ...INIT_HEADERS, "content-encoding": "gzip" },
    body: gzipSync(initializeBody()),
  });
  assert.equal(encoded.status, 415);
  assert.match(encoded.body, /Content-Encoding must be identity/);
});

test("Streamable HTTP closes slow header and body uploads", async (t) => {
  const http = await serveHttp(
    {
      port: 0,
      headersTimeoutMs: 100,
      requestTimeoutMs: 200,
      socketTimeoutMs: 1_000,
    },
    fakeServices(new GameStore()),
  );
  t.after(() => http.close());

  await waitForConnectionClose(
    http.url,
    "POST /mcp HTTP/1.1\r\nHost:",
    "slow header",
  );
  await waitForConnectionClose(
    http.url,
    [
      "POST /mcp HTTP/1.1",
      "Host: 127.0.0.1",
      "Content-Type: application/json",
      "Content-Length: 100",
      "",
      "{",
    ].join("\r\n"),
    "slow body",
  );
});

test("Streamable HTTP returns JSON-RPC 408 before closing a timed out body", async (t) => {
  const http = await serveHttp(
    { port: 0, bodyTimeoutMs: 50, socketTimeoutMs: 1_000 },
    fakeServices(new GameStore()),
  );
  t.after(() => http.close());

  const response = await slowRejectedRequest(http.url, ["Host: 127.0.0.1"], "body timeout");
  assert.match(response, /^HTTP\/1\.1 408 /);
  assert.match(response, /connection: close/i);
  assert.match(response, /\"jsonrpc\":\"2\.0\"/);
  assert.match(response, /request body timed out/);
});

test("Streamable HTTP shutdown closes partial uploads promptly", async (t) => {
  const http = await serveHttp(
    { port: 0, bodyTimeoutMs: 10_000, socketTimeoutMs: 10_000 },
    fakeServices(new GameStore()),
  );
  const upload = await partialPost(http.url);
  t.after(async () => {
    upload.destroy();
    await http.close();
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.race([
    http.close(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("HTTP shutdown waited for a partial body")), 1_000),
    ),
  ]);
});

test("Streamable HTTP accepts bracketed IPv6 bind hosts", async (t) => {
  for (const host of [
    "[0:0:0:0:0:0:0:0]",
    "0:0:0:0:0:0:0:0",
    "0x0",
    "[::ffff:0.0.0.0]",
    "::ffff:0.0.0.0",
    "[0:0:0:0:0:ffff:0:0]",
  ]) {
    await assert.rejects(
      serveHttp({ host, port: 0 }, fakeServices(new GameStore())),
      /wildcard HTTP binding requires allowed hostnames/,
    );
  }

  const loopback = await serveHttp({ host: "[::1]", port: 0 }, fakeServices(new GameStore()));
  const mapped = await serveHttp(
    { host: "[::ffff:127.0.0.1]", port: 0 },
    fakeServices(new GameStore()),
  );
  const wildcard = await serveHttp(
    { host: "[::]", port: 0, allowedHosts: ["[::]"] },
    fakeServices(new GameStore()),
  );
  t.after(async () => {
    await loopback.close();
    await mapped.close();
    await wildcard.close();
  });

  assert.equal(loopback.host, "[::1]");
  assert.match(loopback.url, /^http:\/\/\[::1\]:\d+\/mcp$/);
  assert.equal(
    (await httpRequest(loopback.url, { headers: { host: "[::1]" } })).status,
    400,
  );

  assert.match(mapped.url, /^http:\/\/\[::ffff:7f00:1\]:\d+\/mcp$/);
  assert.equal((await httpRequest(mapped.url)).status, 400);

  assert.equal(wildcard.host, "[::]");
  assert.match(wildcard.url, /^http:\/\/\[::\]:\d+\/mcp$/);
  assert.equal(
    (await httpRequest(wildcard.url, { headers: { host: "[::]" } })).status,
    400,
  );
});

test("Streamable HTTP compares allowed hostnames case-insensitively", async (t) => {
  const http = await serveHttp(
    { port: 0, allowedHosts: ["EXAMPLE.COM"] },
    fakeServices(new GameStore()),
  );
  t.after(() => http.close());

  const response = await httpRequest(http.url, {
    headers: { host: "example.com", origin: "https://EXAMPLE.COM" },
  });
  assert.equal(response.status, 400);
  assert.match(response.body, /MCP session initialization requires POST/);
});

test("Streamable HTTP prefers bodyTimeoutMs over its legacy alias", async (t) => {
  const http = await serveHttp(
    {
      port: 0,
      headersTimeoutMs: 100,
      bodyTimeoutMs: 100,
      requestTimeoutMs: 1_000,
      socketTimeoutMs: 1_000,
    },
    fakeServices(new GameStore()),
  );
  t.after(() => http.close());

  const startedAt = Date.now();
  await waitForConnectionClose(
    http.url,
    [
      "POST /mcp HTTP/1.1",
      "Host: 127.0.0.1",
      "Content-Type: application/json",
      "Content-Length: 100",
      "",
      "{",
    ].join("\r\n"),
    "body timeout",
  );
  assert.ok(Date.now() - startedAt < 500);
});

test("Streamable HTTP reserves and reclaims bounded MCP sessions", async (t) => {
  const http = await serveHttp(
    { port: 0, maxSessions: 1, sessionIdleTtlMs: 20, sessionSweepIntervalMs: 5 },
    fakeServices(new GameStore()),
  );
  t.after(() => http.close());

  const initialized = await httpRequest(http.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: initializeBody(),
  });
  assert.equal(initialized.status, 200);
  assert.ok(initialized.sessionId);
  assert.equal(http.sessionCount(), 1);

  const capped = await httpRequest(http.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: initializeBody(2),
  });
  assert.equal(capped.status, 503);
  assert.equal(capped.retryAfter, "1");
  assert.match(capped.body, /MCP session limit reached/);

  await waitFor(() => http.sessionCount() === 0);
  const expired = await httpRequest(http.url, {
    headers: { "mcp-session-id": initialized.sessionId },
  });
  assert.equal(expired.status, 404);

  const admitted = await httpRequest(http.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: initializeBody(3),
  });
  assert.equal(admitted.status, 200);
});

test("Streamable HTTP atomically reserves concurrent initializations", async (t) => {
  const http = await serveHttp({ port: 0, maxSessions: 1 }, fakeServices(new GameStore()));
  t.after(() => http.close());

  const [first, second] = await Promise.all([
    httpRequest(http.url, { method: "POST", headers: INIT_HEADERS, body: initializeBody(1) }),
    httpRequest(http.url, { method: "POST", headers: INIT_HEADERS, body: initializeBody(2) }),
  ]);
  assert.deepEqual(
    [first.status, second.status].sort((left, right) => left - right),
    [200, 503],
  );
  assert.equal([first, second].find((result) => result.status === 503)?.retryAfter, "1");
  assert.equal(http.sessionCount(), 1);
});

test("Streamable HTTP rejects excess per-session POSTs", async (t) => {
  const analysis = blockingAnalysis();
  const games = new GameStore();
  const http = await serveHttp(
    { port: 0, maxConcurrentPosts: 2, maxConcurrentPostsPerSession: 1 },
    fakeServices(games, { analyze: analysis.analyze }),
  );
  const { client: firstClient, transport: firstTransport } = await connectClient(
    http,
    "http-post-limit-first",
  );
  t.after(async () => {
    analysis.release();
    await firstClient.close();
    await http.close();
  });

  const gameId = await createGame(firstClient);
  assert.ok(firstTransport.sessionId);
  const headers = {
    ...INIT_HEADERS,
    "mcp-session-id": firstTransport.sessionId,
    "mcp-protocol-version": "2025-11-25",
  };
  const first = httpRequest(http.url, {
    method: "POST",
    headers,
    body: toolCallBody("first", gameId),
  });
  await analysis.started;

  const capped = await httpRequest(http.url, {
    method: "POST",
    headers,
    body: toolCallBody("second", gameId),
  });
  assert.equal(capped.status, 429);
  assert.equal(capped.retryAfter, "1");
  analysis.release();
  assert.equal((await first).status, 200);
});

test("Streamable HTTP rejects excess global POSTs", async (t) => {
  const analysis = blockingAnalysis();
  const games = new GameStore();
  const http = await serveHttp(
    { port: 0, maxConcurrentPosts: 1, maxConcurrentPostsPerSession: 1 },
    fakeServices(games, { analyze: analysis.analyze }),
  );
  const { client: firstClient, transport: firstTransport } = await connectClient(
    http,
    "http-global-limit-first",
  );
  const { client: secondClient, transport: secondTransport } = await connectClient(
    http,
    "http-global-limit-second",
  );
  t.after(async () => {
    analysis.release();
    await firstClient.close();
    await secondClient.close();
    await http.close();
  });

  const gameId = await createGame(firstClient);
  assert.ok(firstTransport.sessionId);
  assert.ok(secondTransport.sessionId);
  const first = httpRequest(http.url, {
    method: "POST",
    headers: {
      ...INIT_HEADERS,
      "mcp-session-id": firstTransport.sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
    body: toolCallBody("first", gameId),
  });
  await analysis.started;

  const capped = await httpRequest(http.url, {
    method: "POST",
    headers: {
      ...INIT_HEADERS,
      "mcp-session-id": secondTransport.sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
    body: toolCallBody("second", gameId),
  });
  assert.equal(capped.status, 503);
  assert.equal(capped.retryAfter, "1");
  analysis.release();
  assert.equal((await first).status, 200);
});

test("Streamable HTTP retains work capacity after a raw disconnect", async (t) => {
  const analysis = blockingAnalysis();
  let calls = 0;
  const games = new GameStore();
  const http = await serveHttp(
    { port: 0, maxConcurrentPosts: 1, maxConcurrentPostsPerSession: 1 },
    fakeServices(games, {
      analyze: async () => {
        calls += 1;
        if (calls === 1) {
          return analysis.analyze();
        }
        return [];
      },
    }),
  );
  const { client: firstClient, transport: firstTransport } = await connectClient(
    http,
    "http-disconnect-first",
  );
  const { client: secondClient } = await connectClient(http, "http-disconnect-second");
  t.after(async () => {
    analysis.release();
    await firstClient.close();
    await secondClient.close();
    await http.close();
  });

  const gameId = await createGame(firstClient);
  assert.ok(firstTransport.sessionId);
  const abandoned = abandonedPost(
    http.url,
    {
      ...INIT_HEADERS,
      "mcp-session-id": firstTransport.sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
    toolCallBody("abandoned", gameId),
  );
  await analysis.started;
  abandoned.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const capped = await secondClient.callTool({
    name: "position_analyze",
    arguments: { game_id: gameId, analysis_level: "fast" },
  });
  assert.equal(capped.isError, true);
  assert.equal(object(object(capped.structuredContent).error).code, "SERVER_BUSY");
  assert.equal(calls, 1);

  analysis.release();
  const admitted = await secondClient.callTool({
    name: "position_analyze",
    arguments: { game_id: gameId, analysis_level: "fast" },
  });
  assert.notEqual(admitted.isError, true);
  assert.equal(calls, 2);
});

test("Streamable HTTP propagates MCP cancellation to active tools", async (t) => {
  const analysis = abortableAnalysis();
  const games = new GameStore();
  const http = await serveHttp({ port: 0 }, fakeServices(games, { analyze: analysis.analyze }));
  const { client } = await connectClient(http, "http-cancel-tests");
  t.after(async () => {
    await client.close();
    await http.close();
  });

  const gameId = await createGame(client);
  const controller = new AbortController();
  const call = client.callTool(
    {
      name: "position_analyze",
      arguments: { game_id: gameId, analysis_level: "fast" },
    },
    { signal: controller.signal },
  ).then(
    () => null,
    (error: unknown) => error,
  );
  await analysis.started;
  controller.abort(new Error("cancelled by test"));

  await analysis.aborted;
  assert.match(String(await call), /cancelled by test/);
});

test("Streamable HTTP reserves bounded capacity for cancellation", async (t) => {
  let started = 0;
  let aborted = 0;
  let markBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    markBothStarted = resolve;
  });
  const games = new GameStore();
  const http = await serveHttp(
    { port: 0, maxConcurrentPosts: 2, maxConcurrentPostsPerSession: 2 },
    fakeServices(games, {
      analyze: async (_fen, _depth, _multipv, signal) => {
        assert.ok(signal);
        started += 1;
        if (started === 2) markBothStarted();
        return new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted += 1;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    }),
  );
  const { client, transport } = await connectClient(
    http,
    "http-saturated-cancel-tests",
  );
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const uploads: Awaited<ReturnType<typeof partialSessionPost>>[] = [];
  t.after(async () => {
    firstAbort.abort();
    secondAbort.abort();
    for (const upload of uploads) upload.destroy();
    await client.close();
    await http.close();
  });

  const gameId = await createGame(client);
  const first = client.callTool(
    {
      name: "position_analyze",
      arguments: { game_id: gameId, analysis_level: "fast" },
    },
    { signal: firstAbort.signal },
  ).catch((error: unknown) => error);
  const second = client.callTool(
    {
      name: "position_analyze",
      arguments: { game_id: gameId, analysis_level: "fast" },
    },
    { signal: secondAbort.signal },
  ).catch((error: unknown) => error);
  await bothStarted;
  assert.ok(transport.sessionId);
  uploads.push(
    await partialSessionPost(http.url, transport.sessionId),
    await partialSessionPost(http.url, transport.sessionId),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  firstAbort.abort(new Error("cancel first saturated request"));
  secondAbort.abort(new Error("cancel second saturated request"));
  await waitFor(() => aborted === 2);
  await Promise.all([first, second]);
});

test("Streamable HTTP session deletion cancels active tools", async (t) => {
  const analysis = abortableAnalysis();
  const games = new GameStore();
  const http = await serveHttp({ port: 0 }, fakeServices(games, { analyze: analysis.analyze }));
  const { client, transport } = await connectClient(http, "http-delete-cancel-tests");
  t.after(async () => {
    await client.close();
    await http.close();
  });

  const gameId = await createGame(client);
  const call = client
    .callTool({
      name: "position_analyze",
      arguments: { game_id: gameId, analysis_level: "fast" },
    })
    .then(
      (result) => result,
      (error: unknown) => error,
  );
  await analysis.started;
  assert.ok(transport.sessionId);
  const terminated = await Promise.race([
    httpRequest(http.url, {
      method: "DELETE",
      headers: {
        "mcp-session-id": transport.sessionId,
        "mcp-protocol-version": "2025-11-25",
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("session DELETE timed out")), 1_000),
    ),
  ]);

  assert.equal(terminated.status, 200);
  await Promise.race([
    analysis.aborted,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("active tool was not cancelled")), 1_000),
    ),
  ]);
  const outcome = await call;
  if (outcome && typeof outcome === "object" && "isError" in outcome) {
    assert.equal(outcome.isError, true);
  } else {
    assert.ok(outcome);
  }
  await waitFor(() => http.sessionCount() === 0);
});

test("Streamable HTTP session deletion aborts partial uploads without consuming dispatch", async (t) => {
  const http = await serveHttp(
    {
      port: 0,
      maxConcurrentPosts: 1,
      maxConcurrentPostsPerSession: 1,
      bodyTimeoutMs: 10_000,
    },
    fakeServices(new GameStore()),
  );
  let upload: Awaited<ReturnType<typeof partialSessionPost>> | undefined;
  t.after(async () => {
    upload?.destroy();
    await http.close();
  });

  const initialized = await httpRequest(http.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: initializeBody(),
  });
  assert.equal(initialized.status, 200);
  assert.ok(initialized.sessionId);
  upload = await partialSessionPost(http.url, initialized.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const admitted = await httpRequest(http.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: initializeBody(2),
  });
  assert.equal(admitted.status, 200);

  const terminated = await httpRequest(http.url, {
    method: "DELETE",
    headers: {
      "mcp-session-id": initialized.sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
  });
  assert.equal(terminated.status, 200);
  await Promise.race([
    upload.closed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("partial session upload stayed open")), 1_000),
    ),
  ]);

  const next = await httpRequest(http.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: initializeBody(3),
  });
  assert.equal(next.status, 200);
});

test("Streamable HTTP does not reap a session during an active POST", async (t) => {
  const analysis = blockingAnalysis();
  const games = new GameStore();
  const http = await serveHttp(
    { port: 0, sessionIdleTtlMs: 200, sessionSweepIntervalMs: 10 },
    fakeServices(games, { analyze: analysis.analyze }),
  );
  const { client } = await connectClient(http, "http-active-ttl-tests");
  t.after(async () => {
    analysis.release();
    await client.close();
    await http.close();
  });

  const gameId = await createGame(client);
  const call = client.callTool({
    name: "position_analyze",
    arguments: { game_id: gameId, analysis_level: "fast" },
  });
  await analysis.started;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(http.sessionCount(), 1);

  analysis.release();
  await call;
  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 250));
  await waitFor(() => http.sessionCount() === 0);
});

test("Streamable HTTP does not reap a session during an active GET stream", async (t) => {
  const http = await serveHttp(
    { port: 0, sessionIdleTtlMs: 200, sessionSweepIntervalMs: 10 },
    fakeServices(new GameStore()),
  );
  t.after(() => http.close());

  const initialized = await httpRequest(http.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: initializeBody(),
  });
  assert.equal(initialized.status, 200);
  assert.ok(initialized.sessionId);
  const stream = await openSse(http.url, initialized.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(http.sessionCount(), 1);

  await stream.close();
  await new Promise((resolve) => setTimeout(resolve, 250));
  await waitFor(() => http.sessionCount() === 0);
});

test("Streamable HTTP shutdown cancels active tools", async (t) => {
  const analysis = abortableAnalysis();
  const games = new GameStore();
  const http = await serveHttp({ port: 0 }, fakeServices(games, { analyze: analysis.analyze }));
  const { client } = await connectClient(http, "http-shutdown-cancel-tests");
  t.after(async () => {
    await client.close();
    await http.close();
  });

  const gameId = await createGame(client);
  const call = client
    .callTool({
      name: "position_analyze",
      arguments: { game_id: gameId, analysis_level: "fast" },
    })
    .then(
      (result) => result,
      (error: unknown) => error,
    );
  await analysis.started;
  const closing = http.close();

  await analysis.aborted;
  await closing;
  const outcome = await call;
  if (outcome && typeof outcome === "object" && "isError" in outcome) {
    assert.equal(outcome.isError, true);
  } else {
    assert.ok(outcome);
  }
  assert.equal(http.sessionCount(), 0);
});
