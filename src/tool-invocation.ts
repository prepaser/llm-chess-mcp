import { AsyncLocalStorage } from "node:async_hooks";

type ToolInvocation = { heavyCharged: boolean };

const invocations = new AsyncLocalStorage<ToolInvocation>();

export function withToolInvocation<T>(work: () => T): T {
  return invocations.run({ heavyCharged: false }, work);
}

export function toolInvocation(): ToolInvocation {
  const invocation = invocations.getStore();
  if (!invocation) throw new Error("missing tool invocation context");
  return invocation;
}
