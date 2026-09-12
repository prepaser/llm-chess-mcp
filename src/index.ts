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
export {
  ANONYMOUS_GAME_SCOPE,
  createScopedGameRepository,
  GAME_TTL_MS,
  GameStore,
  MAX_GAMES,
} from "./games.js";
export { ExplorerError } from "./explorer.js";
export type { HttpServerHandle, HttpServerOptions } from "./http.js";
export type { BearerAuthOptions, HttpSecurityLimits, RateLimit, SecurityRateLimitConfig } from "./http-security.js";
export type { HttpTlsOptions } from "./http-tls.js";
export type { ExplorerResult } from "./explorer.js";
export type {
  GameRepository,
  GameScope,
  GameSnapshot,
  GameStoreOptions,
} from "./games.js";
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
  EngineLine,
  Wdl,
} from "./domain.js";
export type { EngineId, EngineMode, EngineMeta, EngineRequest, EngineOutcome, EngineAnalysis } from "./engines/types.js";
export type { EngineCandidateSet, MultiEngineCandidate } from "./engine-consensus.js";
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

function installShutdown(
  closeTransport: () => Promise<void>,
): (exit: boolean) => void {
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (shutdown ??= closeTransport());
  const request = (exit: boolean): void => {
    void close()
      .then(() => {
        if (exit) process.exit(process.exitCode ?? 0);
      })
      .catch((error: unknown) => {
        console.error("shutdown failed", error);
        if (exit) process.exit(1);
        else process.exitCode = 1;
      });
  };
  process.once("SIGINT", () => request(true));
  process.once("SIGTERM", () => request(true));
  return request;
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
    const shutdown = installShutdown(() => handle.close());
    process.stdin.once("end", () => shutdown(false));
    process.stdin.once("close", () => shutdown(false));
    return;
  }

  const startupAbort = new AbortController();
  const startup = serveHttp({
    ...options,
    signal: startupAbort.signal,
    auth: {
      ...(process.env.HTTP_BEARER === undefined ? {} : { bearer: process.env.HTTP_BEARER }),
      ...(options.bearerFile === undefined ? {} : { bearerFile: options.bearerFile }),
    },
  });
  installShutdown(async () => {
    startupAbort.abort();
    const handle = await startup.catch((error: unknown) => {
      if (error !== startupAbort.signal.reason) throw error;
      return undefined;
    });
    await handle?.close();
  });
  let handle: Awaited<typeof startup>;
  try {
    handle = await startup;
  } catch (error) {
    if (error === startupAbort.signal.reason) return;
    throw error;
  }
  if (startupAbort.signal.aborted) return;
  console.error(`llm-chess-mcp listening on ${handle.url}`);
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
