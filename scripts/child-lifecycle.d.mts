export type ChildExit = [number | null, NodeJS.Signals | null];

export type ChildLike = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
};

export type ChildLifecycle = {
  exited: Promise<ChildExit>;
  wait(timeoutMs: number, label: string): Promise<ChildExit>;
  stop(
    signal: NodeJS.Signals,
    timeoutMs: number,
    label: string,
  ): Promise<ChildExit>;
};

export function childLifecycle(
  child: ChildLike,
  timers?: {
    setTimeout(callback: () => void, delay: number): unknown;
    clearTimeout(timer: unknown): void;
  },
): ChildLifecycle;

export function cleanupChild(
  lifecycle: ChildLifecycle,
  timeoutMs: number,
  label: string,
  primaryError: unknown,
): Promise<void>;
