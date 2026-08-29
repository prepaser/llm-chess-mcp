#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { HELP, parseCli } from "./cli.js";
import { loadEnv } from "./env.js";
import { serveHttp } from "./http.js";
import { buildServer } from "./server.js";

export { buildServer } from "./server.js";
export { serveHttp } from "./http.js";
export { ChessError } from "./errors.js";
export { GAME_TTL_MS, GameStore, MAX_GAMES } from "./games.js";
export { ExplorerError } from "./explorer.js";
export type { HttpServerHandle, HttpServerOptions } from "./http.js";
export type { ExplorerResult } from "./explorer.js";
export type { GameSnapshot, GameStoreOptions } from "./games.js";
export type { CandidateSet, LichessOpts } from "./intents.js";
export type {
  Candidate,
  ChessState,
  DrawResult,
  ExplorerErrorKind,
  HumanModel,
  Intent,
  LichessMove,
  Maia3Move,
  MoveSensitivity,
  Objective,
  OpeningStats,
  SfLine,
  Wdl,
} from "./domain.js";
export type {
  AnalysisServices,
  AppServices,
  CandidateServices,
  ExplorerServices,
  GameServices,
  LifecycleServices,
} from "./services.js";
export {
  drawResult,
  MAX_EVALUATED_MOVES,
  MAX_PGN_BYTES,
  MAX_PGN_HEADERS,
  MAX_PGN_PLIES,
  MAX_PGN_TOKEN_BYTES,
  parseImportedPgn,
  pgnOf,
  snapshotChess,
} from "./chess.js";

function installShutdown(closeTransport: () => Promise<void>): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (shutdown ??= closeTransport());
  const onSignal = (): void => {
    void close()
      .then(() => process.exit(process.exitCode ?? 0))
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
    const handle = serveStdio(() => buildServer(), {
      onerror: (error) => {
        console.error("stdio transport failed", error);
        process.exitCode = 1;
      },
    });
    const close = installShutdown(() => handle.close());
    const onClose = (): void => {
      void close().catch((error: unknown) => {
        console.error("shutdown failed", error);
        process.exitCode = 1;
      });
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
  installShutdown(() => handle.close());
}

function isDirectEntry(entry: string | undefined): boolean {
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectEntry(process.argv[1])) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
