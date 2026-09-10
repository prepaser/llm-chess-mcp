import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import type { EngineLine, EngineMeta, EngineRequest } from "./types.js";
import { WDL_TOTAL } from "../domain.js";

type Lc0ManifestFile = { path: string; sha256: string };
export type Lc0PlatformManifest = {
  executable: string;
  backend: string;
  files?: Lc0ManifestFile[];
};
export type Lc0Manifest = {
  schemaVersion: 1;
  engineVersion: string;
  weights: { path: string; sha256: string };
  platforms: Record<string, Lc0PlatformManifest>;
};

type Lc0Timeouts = {
  init: number;
  handshake: number;
  analyze: number;
  stopGrace: number;
};

export type Lc0Process = {
  stdin: { write(data: string): boolean; end?(): void; once?(event: "error", listener: (error: Error) => void): unknown };
  stdout: { on(event: "data", listener: (data: Buffer | string) => void): unknown };
  stderr?: { on(event: "data", listener: (data: Buffer | string) => void): unknown };
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
};

export type Lc0Spawn = (
  executable: string,
  args: string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; env?: NodeJS.ProcessEnv },
) => Lc0Process;

export type Lc0Options = {
  manifest?: Lc0Manifest;
  manifestPath?: string;
  spawn?: Lc0Spawn;
  maxQueue?: number;
  timeouts?: Partial<Lc0Timeouts>;
  threads?: number;
  minibatchSize?: number;
};

const DEFAULT_TIMEOUTS: Lc0Timeouts = {
  init: 15_000,
  handshake: 15_000,
  analyze: 30_000,
  stopGrace: 2_000,
};
const MAX_TIMER = 2_147_483_647;
const DEFAULT_MAX_QUEUE = 32;
const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = resolve(here, "../../bundle/lc0/manifest.json");
const SHA256 = /^[a-f0-9]{64}$/i;

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function manifestPath(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error(`invalid Lc0 manifest ${name}`);
  return value;
}

function readManifest(path: string): Lc0Manifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`unable to read Lc0 manifest at ${path}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Lc0 manifest: expected object");
  }
  const object = value as Record<string, unknown>;
  if (object.schemaVersion !== 1 || typeof object.engineVersion !== "string" || object.engineVersion.trim() === "") {
    throw new Error("invalid Lc0 manifest metadata");
  }
  const weights = object.weights;
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) {
    throw new Error("invalid Lc0 manifest weights");
  }
  const weightObject = weights as Record<string, unknown>;
  const weightPath = manifestPath(weightObject.path, "weights.path");
  if (typeof weightObject.sha256 !== "string" || !SHA256.test(weightObject.sha256)) {
    throw new Error("invalid Lc0 manifest weights.sha256");
  }
  const platforms = object.platforms;
  if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
    throw new Error("invalid Lc0 manifest platforms");
  }
  const normalized: Record<string, Lc0PlatformManifest> = {};
  for (const [platform, raw] of Object.entries(platforms)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid Lc0 platform ${platform}`);
    const item = raw as Record<string, unknown>;
    const executable = manifestPath(item.executable, `${platform}.executable`);
    if (typeof item.backend !== "string" || item.backend.trim() === "") throw new Error(`invalid Lc0 platform ${platform}.backend`);
    const files: Lc0ManifestFile[] = [];
    if (item.files !== undefined) {
      if (!Array.isArray(item.files)) throw new Error(`invalid Lc0 platform ${platform}.files`);
      for (const rawFile of item.files) {
        if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) throw new Error(`invalid Lc0 platform ${platform}.files entry`);
        const file = rawFile as Record<string, unknown>;
        const filePath = manifestPath(file.path, `${platform}.files.path`);
        if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) throw new Error(`invalid Lc0 platform ${platform}.files.sha256`);
        files.push({ path: filePath, sha256: file.sha256 });
      }
    }
    normalized[platform] = { executable, backend: item.backend, ...(files.length ? { files } : {}) };
  }
  return {
    schemaVersion: 1,
    engineVersion: object.engineVersion,
    weights: { path: weightPath, sha256: weightObject.sha256 },
    platforms: normalized,
  };
}

function selectedManifest(manifest: Lc0Manifest): { manifest: Lc0Manifest; platform: Lc0PlatformManifest; root: string } {
  const key = `${process.platform}-${process.arch}`;
  const platform = manifest.platforms[key];
  if (!platform) throw new Error(`Lc0 platform is not bundled: ${key}`);
  const root = dirname(DEFAULT_MANIFEST);
  return { manifest, platform, root };
}

function bundleFile(root: string, path: string, label: string): string {
  const candidate = resolve(root, path);
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const child = relative(realRoot, realCandidate);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error(`${label} escapes bundle`);
    if (!statSync(realCandidate).isFile()) throw new Error(`${label} is not a regular file`);
    return realCandidate;
  } catch (error) {
    if (error instanceof Error && error.message.includes("escapes bundle")) throw error;
    throw new Error(`${label} not found`);
  }
}

function validTimeouts(value: Partial<Lc0Timeouts> | undefined): Lc0Timeouts {
  const result = { ...DEFAULT_TIMEOUTS };
  if (!value) return result;
  for (const key of Object.keys(result) as (keyof Lc0Timeouts)[]) {
    if (Object.hasOwn(value, key)) {
      const timeout = value[key];
      if (timeout === undefined) continue;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMER) throw new Error(`lc0 ${key} timeout is invalid`);
      result[key] = timeout;
    }
  }
  return result;
}

type Session = {
  process: Lc0Process;
  listeners: Set<(line: string) => void>;
  exit: Promise<void>;
  resetOutput(): void;
  supportsWdl: boolean;
  supportsScoreType: boolean;
  meta: { version: string; weightsSha256: string; backend: string };
};
type Queued = { signal?: AbortSignal; run: () => Promise<EngineLine[]>; reject: (error: Error) => void; resolve: (lines: EngineLine[]) => void; cancelled: boolean };

function parseInfo(line: string, maxMultipv = 10): EngineLine | null {
  if (!line.startsWith("info")) return null;
  const score = line.match(/\sscore (cp|mate) (-?\d+)(?=\s|$)/);
  const cp = score?.[1] === "cp" ? Number(score[2]) : null;
  const mate = score?.[1] === "mate" ? Number(score[2]) : null;
  if ((cp !== null && !Number.isSafeInteger(cp)) || (mate !== null && !Number.isSafeInteger(mate))) return null;
  const multipvToken = line.match(/\smultipv (\d+)(?=\s|$)/)?.[1];
  const multipv = multipvToken ? Number(multipvToken) : 1;
  if (!Number.isSafeInteger(multipv) || multipv < 1 || multipv > maxMultipv) return null;
  const pv = line.match(/\spv (.+)$/)?.[1];
  const wdlTokens = line.match(/\swdl (\d+) (\d+) (\d+)(?=\s|$)/);
  const wdl = wdlTokens ? wdlTokens.slice(1).map(Number) : null;
  const validWdl = wdl && wdl.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= WDL_TOTAL) && wdl.reduce((sum, value) => sum + value, 0) === WDL_TOTAL ? [wdl[0]!, wdl[1]!, wdl[2]!] as [number, number, number] : null;
  if (!score && !pv && !validWdl) return null;
  const pvMoves = pv ? pv.trim().split(/\s+/).slice(0, 128) : [];
  if (cp !== null) return { multipv, scoreCp: cp, scoreMate: null, wdl: validWdl, pv: pvMoves };
  if (mate !== null) return { multipv, scoreCp: null, scoreMate: mate, wdl: validWdl, pv: pvMoves };
  return { multipv, scoreCp: null, scoreMate: null, wdl: validWdl, pv: pvMoves };
}

export class Lc0 {
  private readonly options: { spawn: Lc0Spawn; maxQueue: number; manifestPath?: string; timeouts: Lc0Timeouts; threads: number; minibatchSize: number };
  private readonly manifest: Lc0Manifest | undefined;
  private session: Session | null = null;
  private initializing: Promise<Session> | null = null;
  private pendingProcess: { process: Lc0Process; exit: Promise<void> } | null = null;
  private queue: Queued[] = [];
  private running = false;
  private runningTask: Promise<void> | null = null;
  private readonly processes = new Map<Lc0Process, Promise<void>>();
  private readonly exited = new WeakSet<Lc0Process>();
  private readonly terminations = new WeakMap<Lc0Process, Promise<void>>();
  private quitting: Promise<void> | null = null;

  constructor(options: Lc0Options = {}) {
    this.options = {
      spawn: options.spawn ?? ((executable, args, spawnOptions) => nodeSpawn(executable, args, spawnOptions) as unknown as Lc0Process),
      maxQueue: options.maxQueue ?? DEFAULT_MAX_QUEUE,
      ...(options.manifestPath !== undefined ? { manifestPath: options.manifestPath } : {}),
      timeouts: validTimeouts(options.timeouts),
      threads: options.threads ?? 2,
      minibatchSize: options.minibatchSize ?? 16,
    };
    if (!Number.isSafeInteger(this.options.maxQueue) || this.options.maxQueue < 1) throw new Error("lc0 maxQueue must be a positive safe integer");
    if (!Number.isSafeInteger(this.options.threads) || this.options.threads < 1 || this.options.threads > 128) throw new Error("lc0 threads must be a positive safe integer no greater than 128");
    if (!Number.isSafeInteger(this.options.minibatchSize) || this.options.minibatchSize < 1) throw new Error("lc0 minibatchSize must be a positive safe integer");
    this.manifest = options.manifest;
  }

  private bundle(): { manifest: Lc0Manifest; platform: Lc0PlatformManifest; root: string } {
    const path = this.options.manifestPath ?? DEFAULT_MANIFEST;
    const manifest = this.manifest ?? readManifest(path);
    const selected = selectedManifest(manifest);
    return { ...selected, root: dirname(path) };
  }

  private init(signal?: AbortSignal): Promise<Session> {
    if (this.session) return Promise.resolve(this.session);
    if (this.initializing) return this.initializing;
    const pending = this.startSession(signal).finally(() => {
      if (this.initializing === pending) this.initializing = null;
    });
    this.initializing = pending;
    return pending;
  }

  private async startSession(signal?: AbortSignal): Promise<Session> {
    await Promise.all([...this.processes].map(([process, exit]) => this.terminateProcess(process, exit)));
    signal?.throwIfAborted();
    if (this.quitting) throw new Error("lc0 shutting down");
    const { manifest, platform, root } = this.bundle();
    const executable = bundleFile(root, platform.executable, "Lc0 executable");
    const weights = bundleFile(root, manifest.weights.path, "Lc0 weights");
    const args = [`--weights=${weights}`, `--backend=${platform.backend}`, `--config=`, `--threads=${this.options.threads}`, `--minibatch-size=${this.options.minibatchSize}`];
    for (const file of platform.files ?? []) bundleFile(root, file.path, "Lc0 library");
    const threads = String(this.options.threads);
    const child = this.options.spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENBLAS_NUM_THREADS: threads, OMP_NUM_THREADS: threads, MKL_NUM_THREADS: threads,
        ...(process.platform === "linux" ? {
          LD_LIBRARY_PATH: [dirname(executable), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
        } : {}),
      },
    });
    let resolveExit!: () => void;
    const exit = new Promise<void>((resolvePromise) => { resolveExit = resolvePromise; });
    this.processes.set(child, exit);
    this.pendingProcess = { process: child, exit };
    let buffer = "";
    const listeners = new Set<(line: string) => void>();
    let processError: Error | null = null;
    let outputBytes = 0;
    const failProcess = (error: Error) => {
      if (processError) return;
      processError = error;
      if (this.session?.process === child) this.session = null;
      for (const listener of [...listeners]) listener("__lc0_process_exit__");
      void this.terminateProcess(child, exit).catch(() => {});
    };
    child.stdout.on("data", (data) => {
      outputBytes += Buffer.byteLength(String(data));
      if (outputBytes > 1_048_576) { failProcess(new Error("Lc0 output exceeded limit")); try { child.kill(); } catch {} return; }
      buffer += String(data);
      if (!buffer.includes("\n") && buffer.length > 65_536) { failProcess(new Error("Lc0 output line exceeded limit")); try { child.kill(); } catch {} return; }
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        if (index > 65_536) { failProcess(new Error("Lc0 output line exceeded limit")); return; }
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        for (const listener of [...listeners]) listener(line);
      }
    });
    let stderrBytes = 0;
    child.stderr?.on("data", (data) => {
      stderrBytes = Math.min(65_536, stderrBytes + Buffer.byteLength(String(data)));
    });
    child.once("error", failProcess);
    const onExit = (code: number | null, signal: string | null) => {
      if (this.exited.has(child)) return;
      this.exited.add(child);
      this.processes.delete(child);
      resolveExit();
      if (!processError) processError = new Error(`Lc0 exited before completion (${code ?? signal ?? "unknown"})`);
      if (this.session?.process === child) this.session = null;
      for (const listener of [...listeners]) listener("__lc0_process_exit__");
    };
    child.once("exit", onExit);
    child.once("close", onExit);
    child.stdin.once?.("error", failProcess);
    const command = (value: string): void => {
      if (processError) throw processError;
      child.stdin.write(`${value}\n`);
    };
    const abortInit = () => {
      const pending = this.pendingProcess;
      if (pending?.process === child) {
        failProcess(signal?.reason instanceof Error ? signal.reason : new Error("operation aborted"));
      }
    };
    signal?.addEventListener("abort", abortInit, { once: true });
    try {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
      const handshake = await this.waitForHandshake(command, listeners, manifest.engineVersion, Math.min(this.options.timeouts.init, this.options.timeouts.handshake), () => processError);
      signal?.throwIfAborted();
      if (this.quitting) throw new Error("lc0 shutting down");
      const session: Session = { process: child, listeners, exit, resetOutput: () => { outputBytes = 0; }, meta: { version: handshake.version, weightsSha256: manifest.weights.sha256, backend: platform.backend }, supportsWdl: handshake.supportsWdl, supportsScoreType: handshake.supportsScoreType };
      this.pendingProcess = null;
      this.session = session;
      return session;
    } catch (error) {
      this.pendingProcess = null;
      await this.terminateProcess(child, exit);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortInit);
    }
  }

  private waitForHandshake(command: (value: string) => void, listeners: Set<(line: string) => void>, expectedVersion: string, timeoutMs: number, failure: () => Error | null): Promise<{ version: string; supportsWdl: boolean; supportsScoreType: boolean }> {
    return new Promise((resolvePromise, reject) => {
      let stage: "uci" | "ready" = "uci";
      let name = "";
      const options = new Set<string>();
      let scoreTypeCentipawn = false;
      let settled = false;
      let handshakeResult: { version: string; supportsWdl: boolean; supportsScoreType: boolean } | undefined;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); listeners.delete(listener); if (error) reject(error); else if (handshakeResult) resolvePromise(handshakeResult); else reject(new Error("Lc0 handshake incomplete")); };
      const listener = (line: string) => {
        if (failure()) { finish(failure()!); return; }
        if (line === "__lc0_process_exit__") { finish(failure() ?? new Error("Lc0 process exited")); return; }
        if (line.startsWith("id name ")) name = line.slice(8).trim();
        const option = line.match(/^option name (.+?) type /i)?.[1];
        if (option) {
          options.add(option.trim().toLowerCase());
          if (option.trim().toLowerCase() === "scoretype" && /\bvar\s+centipawn\b/i.test(line)) scoreTypeCentipawn = true;
        }
        if (stage === "uci" && line === "uciok") { stage = "ready"; try { command("isready"); } catch (error) { finish(errorOf(error)); } }
        else if (stage === "ready" && line === "readyok") {
          const version = name.match(/\bv(\d+\.\d+\.\d+)(?=\s|$)/i)?.[1];
          if (!version) finish(new Error("Lc0 did not report an engine version"));
          else if (expectedVersion !== version) finish(new Error(`Lc0 version mismatch: expected ${expectedVersion}, got ${version}`));
          else if (![...options].some((option) => option === "multipv")) finish(new Error("Lc0 does not support MultiPV"));
          else if ([...options].some((option) => option === "scoretype") && !scoreTypeCentipawn) finish(new Error("Lc0 does not support centipawn ScoreType"));
          else { handshakeResult = { version, supportsWdl: [...options].some((option) => option === "uci_showwdl"), supportsScoreType: [...options].some((option) => option === "scoretype") }; finish(); }
        }
      };
      const timer = setTimeout(() => finish(new Error("lc0 handshake timeout")), timeoutMs);
      listeners.add(listener);
      try { command("uci"); } catch (error) { finish(errorOf(error)); }
    });
  }

  analyze(fen: string, request: EngineRequest, history: readonly string[] = [], signal?: AbortSignal): Promise<EngineLine[]> {
    if (typeof fen !== "string" || /[\r\n]/.test(fen)) return Promise.reject(new Error("invalid Lc0 FEN"));
    if (!request || typeof request !== "object" || Array.isArray(request)) return Promise.reject(new Error("invalid Lc0 analysis request"));
    if (!Array.isArray(history)) return Promise.reject(new Error("invalid Lc0 UCI history"));
    if (request.mode !== undefined && request.mode !== "lc0" && request.mode !== "both") return Promise.reject(new Error("Lc0 cannot serve the requested engine mode"));
    if (!Number.isSafeInteger(request.depth) || request.depth < 1 || request.depth > 30 || !Number.isSafeInteger(request.multipv) || request.multipv < 1 || request.multipv > 10 || !Number.isSafeInteger(request.movetimeMs) || request.movetimeMs < 1 || request.movetimeMs > 30_000) return Promise.reject(new Error("invalid Lc0 analysis request"));
    const moves = [...history];
    try {
      const replay = new Chess(fen);
      for (const move of moves) {
        if (typeof move !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw new Error("invalid UCI history move");
        replay.move(move);
      }
    } catch (error) { return Promise.reject(errorOf(error)); }
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("operation aborted"));
    if (this.quitting) return Promise.reject(new Error("lc0 shutting down"));
    if (this.queue.length + (this.running ? 1 : 0) >= this.options.maxQueue) return Promise.reject(new Error("lc0 queue full"));
    let entry!: Queued;
    const requestCopy = { ...request };
    const result = new Promise<EngineLine[]>((resolvePromise, reject) => { entry = { run: () => this.runAnalysis(fen, requestCopy, moves, signal), reject: reject as (error: Error) => void, resolve: resolvePromise, cancelled: false, ...(signal ? { signal } : {}) }; });
    const abort = () => { if (entry.cancelled) return; entry.cancelled = true; const error = signal?.reason instanceof Error ? signal.reason : new Error("operation aborted"); const index = this.queue.indexOf(entry); if (index >= 0) { this.queue.splice(index, 1); entry.reject(error); } else if (!this.running) entry.reject(error); };
    signal?.addEventListener("abort", abort, { once: true });
    this.queue.push(entry);
    this.schedule();
    return result.finally(() => signal?.removeEventListener("abort", abort));
  }

  private schedule(): void {
    if (this.running || this.quitting) return;
    const entry = this.queue.shift();
    if (!entry) return;
    if (entry.cancelled) { this.schedule(); return; }
    this.running = true;
    this.runningTask = entry.run().then(entry.resolve, entry.reject).finally(() => { this.running = false; this.runningTask = null; this.schedule(); });
  }

  private async runAnalysis(fen: string, request: EngineRequest, history: readonly string[], signal?: AbortSignal): Promise<EngineLine[]> {
    const session = await this.init(signal);
    if (signal?.aborted) {
      await this.invalidate(session);
      throw signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
    }
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const bufferLines = new Map<number, EngineLine>();
      let stopSent = false;
      let stopReason: Error | null = null;
      let stopTimer: NodeJS.Timeout | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stopTimer) clearTimeout(stopTimer);
        session.listeners.delete(listener);
        signal?.removeEventListener("abort", onAbort);
        const failure = error ?? (bufferLines.size === 0 ? new Error("Lc0 returned no analysis lines") : null);
        if (failure) void this.invalidate(session).then(() => reject(failure), reject);
        else resolvePromise([...bufferLines.values()].sort((a, b) => a.multipv - b.multipv));
      };
      const listener = (line: string) => {
        if (line === "__lc0_process_exit__") { finish(new Error("Lc0 process exited")); return; }
        if (line.startsWith("info")) {
          const parsed = parseInfo(line, request.multipv);
          if (parsed) {
            const old = bufferLines.get(parsed.multipv);
            const scored = parsed.scoreCp === null && parsed.scoreMate === null && old ? old : parsed;
            bufferLines.set(parsed.multipv, { ...scored, wdl: parsed.wdl ?? old?.wdl ?? null, pv: parsed.pv.length ? parsed.pv : old?.pv ?? [] });
          }
        }
        else if (line.startsWith("bestmove")) finish(stopReason ?? undefined);
      };
      const stop = (error: Error) => { if (stopSent) return; stopSent = true; stopReason = error; try { session.process.stdin.write("stop\n"); } catch {} stopTimer = setTimeout(() => finish(error), this.options.timeouts.stopGrace); };
      const onAbort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error("operation aborted"));
      const timer = setTimeout(() => stop(new Error("lc0 analyze timeout")), Math.min(this.options.timeouts.analyze, request.movetimeMs + this.options.timeouts.stopGrace));
      session.listeners.add(listener);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal?.aborted) { onAbort(); return; }
        session.resetOutput();
        if (session.supportsScoreType) session.process.stdin.write("setoption name ScoreType value centipawn\n");
        if (session.supportsWdl) session.process.stdin.write("setoption name UCI_ShowWDL value true\n");
        session.process.stdin.write(`position fen ${fen}${history.length ? ` moves ${history.join(" ")}` : ""}\n`);
        session.process.stdin.write(`setoption name MultiPV value ${request.multipv}\n`);
        session.process.stdin.write(`go movetime ${request.movetimeMs}\n`);
      } catch (error) { finish(errorOf(error)); }
    });
  }

  async metadata(): Promise<EngineMeta> {
    const session = await this.init();
    return {
      id: "lc0",
      version: session.meta.version,
      weightsSha256: session.meta.weightsSha256,
      backend: session.meta.backend,
    };
  }

  private invalidate(session: Session): Promise<void> {
    if (this.session === session) this.session = null;
    return this.terminateProcess(session.process, session.exit);
  }

  private terminateProcess(process: Lc0Process, exit: Promise<void>): Promise<void> {
    if (this.exited.has(process)) return Promise.resolve();
    const existing = this.terminations.get(process);
    if (existing) return existing;
    const wait = () => new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), this.options.timeouts.stopGrace);
      void exit.then(() => { clearTimeout(timer); resolvePromise(true); });
    });
    const termination = Promise.resolve().then(async () => {
      try { process.stdin.write("quit\n"); } catch {}
      if (await wait()) return;
      try { process.kill("SIGKILL"); } catch {}
      if (!await wait()) throw new Error("Lc0 process did not exit after termination");
    });
    this.terminations.set(process, termination);
    return termination;
  }

  quit(): Promise<void> {
    if (this.quitting) return this.quitting;
    this.quitting = Promise.resolve().then(async () => {
      const error = new Error("lc0 quit");
      for (const entry of this.queue.splice(0)) { entry.cancelled = true; entry.reject(error); }
      this.session = null;
      this.pendingProcess = null;
      await Promise.all([...this.processes].map(([process, exit]) => this.terminateProcess(process, exit)));
      await this.runningTask;
      await this.initializing?.catch(() => {});
    }).finally(() => { this.quitting = null; });
    return this.quitting;
  }
}

export const lc0 = new Lc0();
