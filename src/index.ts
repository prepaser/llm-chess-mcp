#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadEnv } from "./env.js";
import { buildServer } from "./server.js";
import { defaultAppServices } from "./services.js";

export { buildServer } from "./server.js";
export {
  drawResult,
  MAX_EVALUATED_MOVES,
  MAX_PGN_BYTES,
  MAX_PGN_PLIES,
  parseImportedPgn,
  snapshotChess,
} from "./chess.js";

loadEnv();

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
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
}
