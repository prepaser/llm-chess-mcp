#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { HELP, parseCli } from "./cli.js";
import { loadEnv } from "./env.js";
import { serveHttp } from "./http.js";
import { buildServer } from "./server.js";
import { defaultAppServices } from "./services.js";

export { buildServer } from "./server.js";
export { serveHttp } from "./http.js";
export type { HttpServerHandle, HttpServerOptions } from "./http.js";
export type { AppServices } from "./services.js";
export {
  drawResult,
  MAX_EVALUATED_MOVES,
  MAX_PGN_BYTES,
  MAX_PGN_PLIES,
  parseImportedPgn,
  snapshotChess,
} from "./chess.js";

function installShutdown(
  closeTransport: () => Promise<void>,
  closeServices = true,
): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (shutdown ??= Promise.all([
      closeTransport(),
      ...(closeServices ? [defaultAppServices.quit()] : []),
    ]).then(() => undefined));
  const onSignal = (): void => {
    void close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error("shutdown failed", error);
        process.exit(1);
      });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return close;
}

async function main(): Promise<void> {
  loadEnv();
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (options.transport === "stdio") {
    const handle = serveStdio(() => buildServer());
    const close = installShutdown(() => handle.close());
    const onClose = (): void => {
      void close().catch((error: unknown) => console.error("shutdown failed", error));
    };
    process.stdin.once("end", onClose);
    process.stdin.once("close", onClose);
    return;
  }

  const handle = await serveHttp({
    host: options.host,
    port: options.port,
    path: options.path,
    ...(options.allowedHosts.length ? { allowedHosts: options.allowedHosts } : {}),
  });
  console.error(`llm-chess-mcp listening on ${handle.url}`);
  installShutdown(() => handle.close(), false);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
