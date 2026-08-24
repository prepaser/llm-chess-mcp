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
export {
  drawResult,
  MAX_EVALUATED_MOVES,
  MAX_PGN_BYTES,
  MAX_PGN_PLIES,
  parseImportedPgn,
  snapshotChess,
} from "./chess.js";

loadEnv();

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (options.transport === "stdio") {
    const handle = serveStdio(() => buildServer());
    let shutdown: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (shutdown ??= Promise.all([defaultAppServices.quit(), handle.close()]).then(
        () => undefined,
      ));
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
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (shutdown ??= handle.close().finally(() => defaultAppServices.quit()));
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
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
