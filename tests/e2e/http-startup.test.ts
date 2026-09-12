import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REPO,
  childEnv,
  killIfRunning,
  waitForExit,
  waitForOutput,
} from "../support/process.js";

const ACME_STALL_LOADER = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier !== "acme-client") return nextResolve(specifier, context);
  const source = \
    'import { writeFileSync } from "node:fs";\\n' +
    'export const crypto = { createPrivateRsaKey: async () => "account-key", createCsr: async () => ["private-key", "csr"] };\\n' +
    'export class Client { auto() { writeFileSync(process.env.ACME_STALL_MARKER, "started\\\\n"); process.stderr.write("ACME_STALLED\\\\n"); return new Promise(() => {}); } }\\n';
  return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
}
`;

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

for (const signal of ["SIGTERM", "SIGINT"] as const) test(
  `CLI exits cleanly when ${signal} cancels initial ACME issuance`,
  { timeout: 20_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "llm-chess-mcp-cli-startup-"));
    const marker = join(dir, "acme-stalled");
    const preload = join(dir, "acme-stall.mjs");
    await writeFile(preload, ACME_STALL_LOADER, { mode: 0o600 });

    const challengeProbe = createServer();
    const challengePort = await listen(challengeProbe);
    await close(challengeProbe);
    const child = spawn(
      process.execPath,
      [
        "--experimental-loader",
        preload,
        "dist/index.js",
        "--transport",
        "http",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--acme-domain",
        "example.com",
        "--acme-email",
        "operator@example.com",
        "--acme-storage",
        dir,
        "--acme-agree-tos",
        "--acme-staging",
        "--acme-challenge-host",
        "127.0.0.1",
        "--acme-challenge-port",
        String(challengePort),
      ],
      {
        cwd: REPO,
        env: { ...childEnv(), ACME_STALL_MARKER: marker },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = waitForExit(child, () => stderr, "HTTP ACME startup", 10_000);

    try {
      await waitForOutput(
        child,
        "stderr",
        () => stderr.includes("ACME_STALLED"),
        () => stderr,
        "HTTP ACME startup",
        10_000,
      );
      await stat(join(dir, "issue.lock"));
      child.kill(signal);
      const [code, receivedSignal] = await exited;
      assert.equal(code, 0, stderr);
      assert.equal(receivedSignal, null);
      await assert.rejects(stat(join(dir, "issue.lock")), { code: "ENOENT" });

      const challengeCheck = createServer();
      try {
        await listen(challengeCheck, challengePort);
      } finally {
        await close(challengeCheck);
      }
    } finally {
      killIfRunning(child);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
