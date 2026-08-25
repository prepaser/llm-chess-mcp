import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const CALL_TIMEOUT_MS = 30_000;
export const CHILD_TIMEOUT_MS = 10_000;

export function childEnv(
  excluded: readonly string[] = ["LICHESS_TOKEN"],
): Record<string, string> {
  const excludedKeys = new Set(excluded);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !excludedKeys.has(entry[0]) && entry[1] !== undefined,
    ),
  );
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export function waitForExit(
  child: ChildProcess,
  stderr: () => string,
  label: string,
  timeoutMs = CHILD_TIMEOUT_MS,
): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      result?: [number | null, NodeJS.Signals | null],
      error?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const timer = setTimeout(
      () => finish(undefined, new Error(`${label} did not stop: ${stderr()}`)),
      timeoutMs,
    );
    const onError = (error: Error): void => finish(undefined, error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish([code, signal]);

    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export function waitForOutput(
  child: ChildProcess,
  stream: "stdout" | "stderr",
  contains: () => boolean,
  stderr: () => string,
  label: string,
  timeoutMs = CHILD_TIMEOUT_MS,
): Promise<void> {
  if (contains()) return Promise.resolve();
  const output = child[stream];
  if (!output) return Promise.reject(new Error(`${label} has no ${stream}`));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`${label} did not start: ${stderr()}`)),
      timeoutMs,
    );
    const onData = (): void => {
      if (contains()) finish();
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(new Error(`${label} exited early with ${code}/${signal}: ${stderr()}`));

    output.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export function waitForJsonRpcResponse(
  child: ChildProcess,
  id: number | string,
  stderr: () => string,
  label: string,
  timeoutMs = CHILD_TIMEOUT_MS,
): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) return Promise.reject(new Error(`${label} has no stdout`));

  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`${label} did not initialize: ${stderr()}`)),
      timeoutMs,
    );
    const onData = (chunk: string): void => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message: unknown = JSON.parse(line);
          if (
            message &&
            typeof message === "object" &&
            Reflect.get(message, "id") === id
          ) {
            finish();
            return;
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(new Error(`${label} exited early with ${code}/${signal}: ${stderr()}`));

    stdout.setEncoding("utf8");
    stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export function killIfRunning(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
