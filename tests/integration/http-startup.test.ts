import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveHttp } from "../../src/http.js";

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function canBind(port: number): Promise<void> {
  const server = createServer();
  try {
    await listen(server, port);
  } finally {
    await close(server);
  }
}

test("pre-aborted HTTP startup has no side effects", async () => {
  const controller = new AbortController();
  controller.abort();
  const storageDir = join(tmpdir(), `llm-chess-mcp-pre-aborted-${process.pid}`);

  await assert.rejects(
    serveHttp({
      signal: controller.signal,
      port: 0,
      tls: {
        mode: "acme",
        domain: "example.com",
        email: "operator@example.com",
        storageDir,
        termsOfServiceAgreed: true,
      },
    }),
  );
  await assert.rejects(stat(storageDir), { code: "ENOENT" });
});

for (const readonlyStorage of [false, true]) test(`aborting ACME HTTP startup cleans up or reports lock failure (readonly=${readonlyStorage})`, {
  timeout: 30_000,
  skip: readonlyStorage && (process.platform === "win32" || process.getuid?.() === 0),
}, async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "llm-chess-mcp-startup-abort-"));
  const controller = new AbortController();
  let startup: ReturnType<typeof serveHttp> | undefined;

  let received!: () => void;
  let disconnected!: () => void;
  const requestReceived = new Promise<void>((resolve) => { received = resolve; });
  const requestDisconnected = new Promise<void>((resolve) => { disconnected = resolve; });
  const directory = createServer((request) => {
    request.socket.once("close", disconnected);
    received();
  });
  t.after(async () => {
    controller.abort();
    directory.closeAllConnections();
    try {
      await startup?.then((server) => server.close(), () => {});
    } finally {
      await close(directory);
      if (readonlyStorage) await chmod(storageDir, 0o700);
      await rm(storageDir, { recursive: true, force: true });
    }
  }, { timeout: 10_000 });
  const directoryPort = await listen(directory);

  const challengePortProbe = createServer();
  const challengePort = await listen(challengePortProbe);
  await close(challengePortProbe);
  startup = serveHttp({
    signal: controller.signal,
    host: "127.0.0.1",
    port: 0,
    tls: {
      mode: "acme",
      domain: "example.com",
      email: "operator@example.com",
      storageDir,
      termsOfServiceAgreed: true,
      challengeHost: "127.0.0.1",
      challengePort,
      directoryUrl: `http://127.0.0.1:${directoryPort}/directory`,
      operationTimeoutMs: 30_000,
    },
  });

  await Promise.race([
    requestReceived,
    startup.then(() => { throw new Error("ACME startup completed without a pending directory request"); }),
  ]);
  await stat(join(storageDir, "issue.lock"));
  if (readonlyStorage) await chmod(storageDir, 0o500);
  const pendingStartup = startup;
  await t.test("cancels and releases resources within five seconds", { timeout: 5_000 }, async () => {
    controller.abort();
    if (readonlyStorage) {
      await assert.rejects(pendingStartup, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal((error.errors[1] as NodeJS.ErrnoException).code, "EACCES");
        return true;
      });
    } else {
      await assert.rejects(pendingStartup, /cancelled|closed|aborted/i);
    }
    await requestDisconnected;
    if (readonlyStorage) await stat(join(storageDir, "issue.lock"));
    else await assert.rejects(stat(join(storageDir, "issue.lock")), { code: "ENOENT" });
    await canBind(challengePort);
  });
});

test("the startup signal does not stop a running HTTP handle", async (t) => {
  const controller = new AbortController();
  const server = await serveHttp({ host: "127.0.0.1", port: 0, signal: controller.signal });
  t.after(() => server.close());

  controller.abort();
  const response = await fetch(server.url);
  assert.equal(response.status, 400);
});
