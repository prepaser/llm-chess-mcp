import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Chess } from "chess.js";
import { GameStore } from "../../src/games.js";
import { serveHttp } from "../../src/http.js";
import type { HttpServerOptions } from "../../src/http.js";
import type { AppServices } from "../../src/services.js";
import type { EngineId, EngineOutcome, EngineLine } from "../../src/engines/types.js";

type JsonObject = Record<string, unknown>;
type Response = {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
};

function fakeServices(
  games: AppServices["games"],
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
    body?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.once("error", reject);
      res.once("aborted", () => reject(new Error("response aborted")));
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString(),
        headers: res.headers,
      }));
    });
    req.once("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
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
      clientInfo: { name: "http-security-tests", version: "1.0.0" },
    },
  });
}

function message(body: string): JsonObject {
  const data = body.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const parsed: unknown = JSON.parse(data ? data.slice(6) : body);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as JsonObject;
}

function messages(body: string): JsonObject[] {
  const payloads = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as unknown);
  if (payloads.length === 0) {
    const parsed = JSON.parse(body) as unknown;
    return Array.isArray(parsed) ? parsed as JsonObject[] : [parsed as JsonObject];
  }
  return payloads.flatMap((payload) => Array.isArray(payload) ? payload as JsonObject[] : [payload as JsonObject]);
}

async function initialize(
  url: string,
  bearer?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; sessionId: string }> {
  const response = await httpRequest(url, {
    method: "POST",
    headers: {
      ...INIT_HEADERS,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...extraHeaders,
    },
    body: initializeBody(),
  });
  const sessionId = response.headers["mcp-session-id"];
  return {
    response,
    sessionId: typeof sessionId === "string" ? sessionId : "",
  };
}

async function callTool(
  url: string,
  sessionId: string,
  bearer: string | undefined,
  name: string,
  args: JsonObject,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; result: JsonObject }> {
  const response = await httpRequest(url, {
    method: "POST",
    headers: {
      ...INIT_HEADERS,
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-11-25",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const payload = message(response.body);
  assert.ok(payload.result && typeof payload.result === "object", `unexpected MCP response (${response.status}): ${response.body}`);
  return { response, result: payload.result as JsonObject };
}

function bearerGame(games: GameStore, bearer: string): string {
  const digest = createHash("sha256").update(bearer, "utf8").digest("hex");
  return games.forScope(`bearer:${digest}`).createGame();
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
        res.resume();
        reject(new Error(`SSE request failed with ${res.statusCode}`));
        return;
      }
      resolve({
        close: () => new Promise<void>((done) => {
          res.once("close", done);
          res.destroy();
        }),
      });
    });
    req.end();
  });
}

test("HTTP preserves all engine modes through its work admission wrapper", async (t) => {
  const games = new GameStore();
  const gameId = games.createGame();
  const seen: string[] = [];
  const services: AppServices = {
    ...fakeServices(games),
    analyze: async () => { throw new Error("legacy engine path used"); },
    analyzeEngines: async (_chess, request, signal) => {
      assert.ok(signal);
      const mode = request.mode ?? "both";
      seen.push(mode);
      const enginesUsed: EngineId[] = mode === "both" ? ["stockfish", "lc0"] : [mode];
      const outcome = (id: EngineId): EngineOutcome<EngineLine[]> => enginesUsed.includes(id) ? {
        status: "ok", meta: { id, version: "test", backend: "test", weightsSha256: null },
        result: [{ multipv: 1, scoreCp: 0, scoreMate: null, wdl: null, pv: ["e2e4"] }],
        elapsedMs: 1, limits: { depth: id === "stockfish" ? request.depth : null, movetimeMs: id === "lc0" ? request.movetimeMs : null, multipv: request.multipv },
      } : { status: "not_requested" };
      return { mode, partial: false, enginesUsed, engines: { stockfish: outcome("stockfish"), lc0: outcome("lc0") } };
    },
  };
  const analyzer = services.analyzeEngines!;
  delete services.analyzeEngines;
  const budget = { ratePerMinute: 1, burst: 3 };
  const http = await serveHttp({ port: 0, rateLimits: { work: { global: budget, ip: budget } } }, services);
  t.after(() => http.close());
  const session = await initialize(http.url);
  services.analyzeEngines = analyzer;
  for (const mode of ["stockfish", "lc0", "both"] as const) {
    const { result } = await callTool(http.url, session.sessionId, undefined, "position_analyze", {
      game_id: gameId, analysis_level: "fast", engine_mode: mode,
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const content = result.structuredContent as JsonObject;
    assert.equal(content.mode, mode);
    assert.equal(content.partial, false);
  }
  assert.deepEqual(seen, ["stockfish", "lc0", "both"]);
  const excess = await callTool(http.url, session.sessionId, undefined, "position_analyze", {
    game_id: gameId, analysis_level: "fast", engine_mode: "both",
  });
  assert.equal(((excess.result.structuredContent as JsonObject).error as JsonObject).code, "RATE_LIMITED");
  assert.equal(seen.length, 3);
});

test("Streamable HTTP requires and binds Bearer credentials", async (t) => {
  const http = await serveHttp(
    { port: 0, auth: { bearer: "alpha" } },
    fakeServices(new GameStore()),
  );
  t.after(() => http.close());

  const missing = await httpRequest(http.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: initializeBody(),
  });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers["www-authenticate"], 'Bearer realm="mcp"');

  const invalid = await httpRequest(http.url, {
    method: "POST",
    headers: { ...INIT_HEADERS, authorization: "Bearer wrong" },
    body: initializeBody(),
  });
  assert.equal(invalid.status, 401);

  const valid = await initialize(http.url, "alpha");
  assert.equal(valid.response.status, 200);
  const crossCredential = await httpRequest(http.url, {
    headers: {
      authorization: "Bearer wrong",
      "mcp-session-id": valid.sessionId,
    },
  });
  assert.equal(crossCredential.status, 401);
});

test("Bearer failure budgets do not block valid clients or ordinary traffic", async (t) => {
  const http = await serveHttp(
    {
      port: 0,
      auth: { bearer: "alpha" },
      trustedProxies: ["127.0.0.1/32"],
      rateLimits: {
        request: {
          global: { ratePerMinute: 1_000, burst: 100 },
          ip: { ratePerMinute: 1_000, burst: 100 },
          bearer: { ratePerMinute: 1_000, burst: 100 },
        },
        initialize: {
          global: { ratePerMinute: 1_000, burst: 100 },
          ip: { ratePerMinute: 1_000, burst: 100 },
          bearer: { ratePerMinute: 1_000, burst: 100 },
        },
        authFailure: {
          global: { ratePerMinute: 120, burst: 20 },
          ip: { ratePerMinute: 10, burst: 5 },
          bearer: { ratePerMinute: 0, burst: 1 },
        },
      },
    },
    fakeServices(new GameStore()),
  );
  t.after(() => http.close());

  for (let ipIndex = 1; ipIndex <= 4; ipIndex += 1) {
    const ip = `198.51.100.${ipIndex}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const invalid = await initialize(http.url, "wrong", { "x-forwarded-for": ip });
      assert.equal(invalid.response.status, 401);
    }
  }

  const otherIp = await initialize(http.url, "alpha", { "x-forwarded-for": "198.51.100.5" });
  assert.equal(otherIp.response.status, 200, otherIp.response.body);
  const recoveredIp = await initialize(http.url, "alpha", { "x-forwarded-for": "198.51.100.1" });
  assert.equal(recoveredIp.response.status, 200, recoveredIp.response.body);
});

test("Streamable HTTP rejects authenticated services without game scoping", async () => {
  const services = fakeServices(new GameStore());
  services.games = {
    createGame: () => "unsupported",
    createGameFromChess: () => "unsupported",
    getSnapshot: () => { throw new Error("unsupported"); },
    applyMove: () => { throw new Error("unsupported"); },
    deleteGame: () => false,
    listGames: () => [],
    gameCount: () => 0,
  };
  await assert.rejects(
    serveHttp({ port: 0, auth: { bearer: "alpha" } }, services),
    /scope-aware game repository|forScope/,
  );
});

test("authenticated sessions fail closed when the game repository loses scoping", async (t) => {
  const services = fakeServices(new GameStore());
  const budget = { ratePerMinute: 60, burst: 10 };
  const http = await serveHttp({
    port: 0,
    auth: { bearer: "alpha" },
    rateLimits: { initialize: { global: budget, ip: budget, bearer: budget } },
    maxSessions: 2,
  }, services);
  t.after(() => http.close());
  const existing = await initialize(http.url, "alpha");
  assert.equal(existing.response.status, 200);
  const replacement = new GameStore();
  services.games = replacement.forScope("anonymous");
  const errors = t.mock.method(console, "error", () => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    const rejected = await initialize(http.url, "alpha");
    assert.equal(rejected.response.status, 500);
    assert.equal(rejected.sessionId, "");
    assert.equal(http.sessionCount(), 1);
  }
  errors.mock.restore();
  const retained = await callTool(http.url, existing.sessionId, "alpha", "create_game", {});
  assert.notEqual(retained.result.isError, true);
  assert.equal(replacement.gameCount(), 0);
  services.games = replacement;
  const recovered = await initialize(http.url, "alpha");
  assert.equal(recovered.response.status, 200);
  const created = await callTool(http.url, recovered.sessionId, "alpha", "create_game", {});
  assert.notEqual(created.result.isError, true);
  assert.equal(replacement.forScope("anonymous").gameCount(), 0);
  assert.equal(replacement.gameCount(), 1);
});

test("anonymous sessions still accept replacement repositories without a scope factory", async (t) => {
  const services = fakeServices(new GameStore());
  const http = await serveHttp({ port: 0 }, services);
  t.after(() => http.close());
  const replacement = new GameStore().forScope("anonymous");
  services.games = replacement;
  const session = await initialize(http.url);
  assert.equal(session.response.status, 200);
  const created = await callTool(http.url, session.sessionId, undefined, "create_game", {});
  assert.notEqual(created.result.isError, true);
  assert.equal(replacement.gameCount(), 1);
});

test("Streamable HTTP loads one Bearer per line from the Bearer file", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "llm-chess-http-auth-"));
  const bearerFile = join(directory, "bearers.txt");
  writeFileSync(bearerFile, "alpha\n\nbeta\n", { mode: 0o600 });
  const http = await serveHttp(
    { port: 0, auth: { bearerFile } },
    fakeServices(new GameStore()),
  );
  t.after(async () => {
    await http.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.equal((await initialize(http.url, "alpha")).response.status, 200);
  assert.equal((await initialize(http.url, "beta")).response.status, 200);
  const invalid = await httpRequest(http.url, {
    method: "POST",
    headers: { ...INIT_HEADERS, authorization: "Bearer gamma" },
    body: initializeBody(3),
  });
  assert.equal(invalid.status, 401);
});

test("Streamable HTTP isolates authenticated games and keeps anonymous games shared", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "llm-chess-http-games-"));
  const bearerFile = join(directory, "bearers.txt");
  writeFileSync(bearerFile, "alpha\nbeta\n", { mode: 0o600 });
  const games = new GameStore({ createId: (() => {
    let id = 0;
    return () => `security-game-${++id}`;
  })() });
  const http = await serveHttp(
    {
      port: 0,
      auth: { bearerFile },
      rateLimits: {
        initialize: {
          global: { ratePerMinute: 100, burst: 100 },
          ip: { ratePerMinute: 100, burst: 100 },
          bearer: { ratePerMinute: 100, burst: 100 },
        },
      },
    },
    fakeServices(games),
  );
  t.after(async () => {
    await http.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const alpha = await initialize(http.url, "alpha");
  const alphaGame = await callTool(http.url, alpha.sessionId, "alpha", "create_game", {});
  const alphaGameId = (alphaGame.result.structuredContent as JsonObject).game_id;
  assert.equal(typeof alphaGameId, "string");

  const betaInit = await initialize(http.url, "beta");
  assert.equal(betaInit.response.status, 200);
  const betaView = await callTool(
    http.url,
    betaInit.sessionId,
    "beta",
    "game_state",
    { game_id: alphaGameId },
  );
  assert.equal(betaView.result.isError, true);
  const betaMove = await callTool(
    http.url,
    betaInit.sessionId,
    "beta",
    "game_play_move",
    { game_id: alphaGameId, move: "e4", expected_revision: 0 },
  );
  assert.equal(betaMove.result.isError, true);
  const betaDelete = await callTool(
    http.url,
    betaInit.sessionId,
    "beta",
    "delete_game",
    { game_id: alphaGameId },
  );
  assert.equal(betaDelete.result.isError, true);
  const crossSession = await httpRequest(http.url, {
    headers: {
      authorization: "Bearer beta",
      "mcp-session-id": alpha.sessionId,
    },
  });
  assert.equal(crossSession.status, 404);

  const alphaAgain = await initialize(http.url, "alpha");
  assert.equal(alphaAgain.response.status, 200, alphaAgain.response.body);
  const visible = await callTool(
    http.url,
    alphaAgain.sessionId,
    "alpha",
    "game_state",
    { game_id: alphaGameId },
  );
  assert.equal(visible.result.isError, undefined);
  assert.equal((visible.result.structuredContent as JsonObject).revision, 0);

  const anonymous = await serveHttp({ port: 0 }, fakeServices(games));
  t.after(() => anonymous.close());
  const first = await initialize(anonymous.url);
  const anonymousCannotRead = await callTool(
    anonymous.url,
    first.sessionId,
    undefined,
    "game_state",
    { game_id: alphaGameId },
  );
  assert.equal(anonymousCannotRead.result.isError, true);
  const anonymousCannotMove = await callTool(
    anonymous.url,
    first.sessionId,
    undefined,
    "game_play_move",
    { game_id: alphaGameId, move: "e4", expected_revision: 0 },
  );
  assert.equal(anonymousCannotMove.result.isError, true);
  const anonymousCannotDelete = await callTool(
    anonymous.url,
    first.sessionId,
    undefined,
    "delete_game",
    { game_id: alphaGameId },
  );
  assert.equal(anonymousCannotDelete.result.isError, true);
  const created = await callTool(anonymous.url, first.sessionId, undefined, "create_game", {});
  const gameId = (created.result.structuredContent as JsonObject).game_id;
  const second = await initialize(anonymous.url);
  const shared = await callTool(
    anonymous.url,
    second.sessionId,
    undefined,
    "game_state",
    { game_id: gameId },
  );
  assert.equal(shared.result.isError, undefined);
  for (const denied of [betaView, betaMove, betaDelete, anonymousCannotRead, anonymousCannotMove, anonymousCannotDelete]) {
    assert.equal(((denied.result.structuredContent as JsonObject).error as JsonObject).code, "GAME_NOT_FOUND");
  }
  assert.equal(games.getSnapshot(alphaGameId as string).revision, 0);
});

test("Streamable HTTP allows open CORS preflight without weakening Host checks", async (t) => {
  const http = await serveHttp({ port: 0 }, fakeServices(new GameStore()));
  t.after(() => http.close());

  const preflight = await httpRequest(http.url, {
    method: "OPTIONS",
    headers: {
      origin: "https://attacker.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,mcp-session-id",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
  assert.match(String(preflight.headers["access-control-allow-methods"]), /POST/);

  const invalidHost = await httpRequest(http.url, {
    method: "OPTIONS",
    headers: { host: "attacker.example", origin: "https://attacker.example" },
  });
  assert.equal(invalidHost.status, 403);
});

test("Streamable HTTP rate limits anonymous initialization by client IP", async (t) => {
  const options: HttpServerOptions = {
    port: 0,
    rateLimits: {
      request: {
        global: { ratePerMinute: 100, burst: 100 },
        ip: { ratePerMinute: 100, burst: 100 },
        bearer: { ratePerMinute: 100, burst: 100 },
      },
      initialize: {
        global: { ratePerMinute: 100, burst: 100 },
        ip: { ratePerMinute: 1, burst: 1 },
        bearer: { ratePerMinute: 100, burst: 100 },
      },
    },
  };
  const http = await serveHttp(
    options,
    fakeServices(new GameStore()),
  );
  t.after(() => http.close());

  assert.equal((await initialize(http.url)).response.status, 200);
  const capped = await httpRequest(http.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: initializeBody(2),
  });
  assert.equal(capped.status, 429);
  assert.ok(Number(capped.headers["retry-after"]) >= 1);
});

test("Streamable HTTP uses X-Forwarded-For only for trusted proxies", async (t) => {
  const untrustedOptions: HttpServerOptions = {
    port: 0,
    rateLimits: {
      request: {
        global: { ratePerMinute: 100, burst: 100 },
        ip: { ratePerMinute: 100, burst: 100 },
        bearer: { ratePerMinute: 100, burst: 100 },
      },
      initialize: {
        global: { ratePerMinute: 100, burst: 100 },
        ip: { ratePerMinute: 1, burst: 1 },
        bearer: { ratePerMinute: 100, burst: 100 },
      },
    },
  };
  const untrusted = await serveHttp(
    untrustedOptions,
    fakeServices(new GameStore()),
  );
  const trustedOptions: HttpServerOptions = {
    port: 0,
    trustedProxies: ["127.0.0.1/32"],
    rateLimits: {
      request: {
        global: { ratePerMinute: 100, burst: 100 },
        ip: { ratePerMinute: 100, burst: 100 },
        bearer: { ratePerMinute: 100, burst: 100 },
      },
      initialize: {
        global: { ratePerMinute: 100, burst: 100 },
        ip: { ratePerMinute: 1, burst: 1 },
        bearer: { ratePerMinute: 100, burst: 100 },
      },
    },
  };
  const trusted = await serveHttp(
    trustedOptions,
    fakeServices(new GameStore()),
  );
  t.after(async () => {
    await untrusted.close();
    await trusted.close();
  });

  const forwarded = (url: string, clientIp: string, id: number) => httpRequest(url, {
    method: "POST",
    headers: { ...INIT_HEADERS, "x-forwarded-for": clientIp },
    body: initializeBody(id),
  });
  assert.equal((await forwarded(untrusted.url, "198.51.100.1", 1)).status, 200);
  assert.equal((await forwarded(untrusted.url, "198.51.100.2", 2)).status, 429);

  assert.equal((await forwarded(trusted.url, "198.51.100.1", 1)).status, 200);
  assert.equal((await forwarded(trusted.url, "198.51.100.2", 2)).status, 200);
});

test("Streamable HTTP caps concurrent anonymous sessions per client IP", async (t) => {
  const http = await serveHttp(
    {
      port: 0,
      rateLimits: {
        initialize: {
          global: { ratePerMinute: 100, burst: 100 },
          ip: { ratePerMinute: 100, burst: 100 },
          bearer: { ratePerMinute: 100, burst: 100 },
        },
      },
    },
    fakeServices(new GameStore()),
  );
  const streams: Array<{ close(): Promise<void> }> = [];
  t.after(async () => {
    await Promise.all(streams.map((stream) => stream.close()));
    await http.close();
  });

  const sessions = [] as string[];
  for (let index = 0; index < 4; index += 1) {
    const result = await initialize(http.url, undefined);
    assert.equal(result.response.status, 200);
    sessions.push(result.sessionId);
  }
  for (const sessionId of sessions) streams.push(await openSse(http.url, sessionId));
  const capped = await httpRequest(http.url, {
    method: "POST",
    headers: INIT_HEADERS,
    body: initializeBody(5),
  });
  assert.equal(capped.status, 429);
  assert.ok(Number(capped.headers["retry-after"]) >= 1);
  assert.equal(sessions.length, 4);
});

test("Streamable HTTP keeps cancellation available after normal IP rate exhaustion", { timeout: 5_000 }, async (t) => {
  const games = new GameStore();
  const gameId = games.createGame();
  let started!: () => void;
  let aborted!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  const abort = new Promise<void>((resolve) => { aborted = resolve; });
  const clientAbort = new AbortController();
  const http = await serveHttp(
    {
      port: 0,
      rateLimits: {
        request: {
          global: { ratePerMinute: 1, burst: 2 },
          ip: { ratePerMinute: 1, burst: 2 },
          bearer: { ratePerMinute: 1, burst: 2 },
        },
        initialize: {
          global: { ratePerMinute: 100, burst: 100 },
          ip: { ratePerMinute: 100, burst: 100 },
          bearer: { ratePerMinute: 100, burst: 100 },
        },
        work: {
          global: { ratePerMinute: 100, burst: 100 },
          ip: { ratePerMinute: 100, burst: 100 },
          bearer: { ratePerMinute: 100, burst: 100 },
        },
        control: {
          global: { ratePerMinute: 100, burst: 100 },
          ip: { ratePerMinute: 100, burst: 100 },
          bearer: { ratePerMinute: 100, burst: 100 },
        },
      },
    },
    fakeServices(games, {
      analyze: async (_fen, _depth, _pv, signal) => {
        assert.ok(signal);
        signal.throwIfAborted();
        started();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted();
            reject(signal.reason);
          }, { once: true });
        });
      },
    }),
  );
  t.after(async () => {
    clientAbort.abort();
    await http.close();
  });

  const session = await initialize(http.url);
  assert.equal(session.response.status, 200);
  const pending = httpRequest(http.url, {
    method: "POST",
    signal: clientAbort.signal,
    headers: {
      ...INIT_HEADERS,
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: { name: "position_analyze", arguments: { game_id: gameId, analysis_level: "fast", engine_mode: "stockfish" } },
    }),
  }).catch((error: unknown) => error);
  await start;

  const cancelled = await httpRequest(http.url, {
    method: "POST",
    headers: {
      ...INIT_HEADERS,
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 50, reason: "security test cancellation" },
    }),
  });
  assert.equal(cancelled.status, 202);
  await abort;
  clientAbort.abort();
  await pending;
});

test("Streamable HTTP enforces heavy-work limits across Bearers and forwarded IPs", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "llm-chess-http-work-"));
  const bearerFile = join(directory, "bearers.txt");
  writeFileSync(bearerFile, "alpha\nbeta\n", { mode: 0o600 });
  const games = new GameStore();
  const alphaGame = bearerGame(games, "alpha");
  const betaGame = bearerGame(games, "beta");
  const http = await serveHttp(
    {
      port: 0,
      auth: { bearerFile },
      trustedProxies: ["127.0.0.1/32"],
      rateLimits: {
        request: {
          global: { ratePerMinute: 100, burst: 100 },
          ip: { ratePerMinute: 100, burst: 100 },
          bearer: { ratePerMinute: 100, burst: 100 },
        },
        initialize: {
          global: { ratePerMinute: 100, burst: 100 },
          ip: { ratePerMinute: 100, burst: 100 },
          bearer: { ratePerMinute: 100, burst: 100 },
        },
        work: {
          global: { ratePerMinute: 100, burst: 100 },
          ip: { ratePerMinute: 1, burst: 1 },
          bearer: { ratePerMinute: 1, burst: 1 },
        },
      },
    },
    fakeServices(games, {
      analyze: async () => [{
        multipv: 1,
        scoreCp: 0,
        scoreMate: null,
        wdl: null,
        pv: ["e2e4"],
      }],
    }),
  );
  t.after(async () => {
    await http.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const alpha = await initialize(http.url, "alpha");
  const beta = await initialize(http.url, "beta");
  const ipA = { "x-forwarded-for": "198.51.100.1" };
  const ipB = { "x-forwarded-for": "198.51.100.2" };

  const first = await callTool(
    http.url,
    alpha.sessionId,
    "alpha",
    "position_analyze",
    { game_id: alphaGame, analysis_level: "fast", engine_mode: "stockfish" },
    ipA,
  );
  assert.notEqual(first.result.isError, true, JSON.stringify(first.result));

  const sameBearer = await callTool(
    http.url,
    alpha.sessionId,
    "alpha",
    "position_analyze",
    { game_id: alphaGame, analysis_level: "fast", engine_mode: "stockfish" },
    ipB,
  );
  const sameBearerError = (sameBearer.result.structuredContent as JsonObject).error as JsonObject;
  assert.equal(sameBearer.result.isError, true);
  assert.equal(sameBearerError.code, "RATE_LIMITED");
  assert.equal(typeof sameBearerError.retry_after_seconds, "number");

  const otherBearerSameIp = await callTool(
    http.url,
    beta.sessionId,
    "beta",
    "position_analyze",
    { game_id: betaGame, analysis_level: "fast", engine_mode: "stockfish" },
    ipA,
  );
  const otherBearerError = (otherBearerSameIp.result.structuredContent as JsonObject).error as JsonObject;
  assert.equal(otherBearerSameIp.result.isError, true);
  assert.equal(otherBearerError.code, "RATE_LIMITED");
  assert.equal(typeof otherBearerError.retry_after_seconds, "number");

  const otherIp = await callTool(
    http.url,
    beta.sessionId,
    "beta",
    "position_analyze",
    { game_id: betaGame, analysis_level: "fast", engine_mode: "stockfish" },
    ipB,
  );
  assert.notEqual(otherIp.result.isError, true);

  const bearerExhausted = await callTool(
    http.url,
    alpha.sessionId,
    "alpha",
    "position_analyze",
    { game_id: alphaGame, analysis_level: "fast", engine_mode: "stockfish" },
    ipB,
  );
  const bearerError = (bearerExhausted.result.structuredContent as JsonObject).error as JsonObject;
  assert.equal(bearerExhausted.result.isError, true);
  assert.equal(bearerError.code, "RATE_LIMITED");
  assert.equal(typeof bearerError.retry_after_seconds, "number");
});

test("Streamable HTTP charges bulk move evaluation once per tool invocation", async (t) => {
  const games = new GameStore();
  const gameId = games.createGame();
  let analysisCalls = 0;
  const http = await serveHttp(
    {
      port: 0,
      rateLimits: {
        request: {
          global: { ratePerMinute: 1_000, burst: 100 },
          ip: { ratePerMinute: 1_000, burst: 100 },
          bearer: { ratePerMinute: 1_000, burst: 100 },
        },
        initialize: {
          global: { ratePerMinute: 1_000, burst: 100 },
          ip: { ratePerMinute: 1_000, burst: 100 },
          bearer: { ratePerMinute: 1_000, burst: 100 },
        },
        work: {
          global: { ratePerMinute: 60, burst: 2 },
          ip: { ratePerMinute: 60, burst: 2 },
          bearer: { ratePerMinute: 60, burst: 2 },
        },
      },
    },
    fakeServices(games, {
      analyze: async (fen) => {
        analysisCalls += 1;
        const chess = new Chess(fen);
        const legal = chess.moves({ verbose: true })[0];
        return legal ? [{ multipv: 1, scoreCp: 0, scoreMate: null, wdl: null, pv: [legal.lan] }] : [];
      },
    }),
  );
  t.after(() => http.close());

  const session = await initialize(http.url);
  const twoMoves = await callTool(http.url, session.sessionId, undefined, "move_evaluate", {
    game_id: gameId,
    move: ["e4", "d4"],
    engine_mode: "stockfish",
  });
  assert.notEqual(twoMoves.result.isError, true, JSON.stringify(twoMoves.result));
  assert.equal((twoMoves.result.structuredContent as JsonObject).results instanceof Array, true);
  assert.equal(((twoMoves.result.structuredContent as JsonObject).results as unknown[]).length, 2);

  const tenMoves = await callTool(http.url, session.sessionId, undefined, "move_evaluate", {
    game_id: gameId,
    move: ["a3", "b3", "c3", "d3", "e3", "f3", "g3", "h3", "a4", "b4"],
    engine_mode: "stockfish",
  });
  assert.notEqual(tenMoves.result.isError, true, JSON.stringify(tenMoves.result));
  assert.equal(((tenMoves.result.structuredContent as JsonObject).results as unknown[]).length, 10);
  assert.equal(analysisCalls, 14);

  const exhausted = await callTool(http.url, session.sessionId, undefined, "position_analyze", {
    game_id: gameId,
    analysis_level: "fast",
    engine_mode: "stockfish",
  });
  assert.equal(exhausted.result.isError, true);
  assert.equal(((exhausted.result.structuredContent as JsonObject).error as JsonObject).code, "RATE_LIMITED");
});

test("Streamable HTTP gives concurrent tool calls independent work budgets", async (t) => {
  const games = new GameStore();
  const gameId = games.createGame();
  let startedCount = 0;
  const http = await serveHttp(
    {
      port: 0,
      rateLimits: {
        request: {
          global: { ratePerMinute: 1_000, burst: 100 },
          ip: { ratePerMinute: 1_000, burst: 100 },
          bearer: { ratePerMinute: 1_000, burst: 100 },
        },
        initialize: {
          global: { ratePerMinute: 1_000, burst: 100 },
          ip: { ratePerMinute: 1_000, burst: 100 },
          bearer: { ratePerMinute: 1_000, burst: 100 },
        },
        work: {
          global: { ratePerMinute: 60, burst: 2 },
          ip: { ratePerMinute: 60, burst: 2 },
          bearer: { ratePerMinute: 60, burst: 2 },
        },
      },
    },
    fakeServices(games, {
      analyze: async (fen) => {
        startedCount += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        const legal = new Chess(fen).moves({ verbose: true })[0];
        return legal ? [{ multipv: 1, scoreCp: 0, scoreMate: null, wdl: null, pv: [legal.lan] }] : [];
      },
    }),
  );
  t.after(() => http.close());

  const firstSession = await initialize(http.url);
  const secondSession = await initialize(http.url);
  const first = callTool(http.url, firstSession.sessionId, undefined, "position_analyze", {
    game_id: gameId, analysis_level: "fast", engine_mode: "stockfish",
  });
  const second = callTool(http.url, secondSession.sessionId, undefined, "position_analyze", {
    game_id: gameId, analysis_level: "fast", engine_mode: "stockfish",
  });
  const results = await Promise.all([first, second]);
  assert.equal(results.every(({ result }) => result.isError !== true), true, JSON.stringify(results));
  assert.equal(startedCount, 2);
  const excess = await callTool(http.url, firstSession.sessionId, undefined, "position_analyze", {
    game_id: gameId, analysis_level: "fast", engine_mode: "stockfish",
  });
  assert.equal(((excess.result.structuredContent as JsonObject).error as JsonObject).code, "RATE_LIMITED");
});

test("Streamable HTTP charges each legacy batch member independently", async (t) => {
  const games = new GameStore();
  const gameId = games.createGame();
  const http = await serveHttp(
    {
      port: 0,
      rateLimits: {
        request: {
          global: { ratePerMinute: 1_000, burst: 100 },
          ip: { ratePerMinute: 1_000, burst: 100 },
          bearer: { ratePerMinute: 1_000, burst: 100 },
        },
        initialize: {
          global: { ratePerMinute: 1_000, burst: 100 },
          ip: { ratePerMinute: 1_000, burst: 100 },
          bearer: { ratePerMinute: 1_000, burst: 100 },
        },
        work: {
          global: { ratePerMinute: 60, burst: 2 },
          ip: { ratePerMinute: 60, burst: 2 },
          bearer: { ratePerMinute: 60, burst: 2 },
        },
      },
    },
    fakeServices(games, {
      analyze: async (fen) => {
        const legal = new Chess(fen).moves({ verbose: true })[0];
        return legal ? [{ multipv: 1, scoreCp: 0, scoreMate: null, wdl: null, pv: [legal.lan] }] : [];
      },
    }),
  );
  t.after(() => http.close());

  const session = await initialize(http.url);
  const response = await httpRequest(http.url, {
    method: "POST",
    headers: {
      ...INIT_HEADERS,
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify([1, 2].map((id) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "position_analyze",
        arguments: { game_id: gameId, analysis_level: "fast", engine_mode: "stockfish" },
      },
    }))),
  });
  assert.equal(response.status, 200, response.body);
  const payloads = messages(response.body);
  assert.equal(payloads.length, 2, response.body);
  for (const payload of payloads) {
    assert.ok(payload.result && typeof payload.result === "object");
    assert.notEqual((payload.result as JsonObject).isError, true, JSON.stringify(payload));
  }
  const excess = await callTool(http.url, session.sessionId, undefined, "position_analyze", {
    game_id: gameId, analysis_level: "fast", engine_mode: "stockfish",
  });
  assert.equal(((excess.result.structuredContent as JsonObject).error as JsonObject).code, "RATE_LIMITED");
});
