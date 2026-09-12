import { ChessError } from "./errors.js";
import type { HttpSecurity, RateLimitDecision, SecuritySubject } from "./http-rate-limit.js";
import type { WorkRunner } from "./http-work.js";
import { toolInvocation } from "./tool-invocation.js";

function limited(message: string, decision: RateLimitDecision): ChessError {
  return new ChessError("RATE_LIMITED", message, Math.max(1, Math.ceil(decision.retryAfterMs / 1_000)));
}

export function withHttpWorkBudget(
  run: WorkRunner,
  security: HttpSecurity,
  getSubject: () => SecuritySubject | undefined,
): WorkRunner {
  return (request, work) => run(request, async (signal) => {
    const subject = getSubject();
    if (!subject) throw new Error("missing HTTP work context");
    const invocation = toolInvocation();
    const lease = security.acquire("work", subject);
    if (!("release" in lease)) throw limited("HTTP work concurrency limit reached", lease);
    try {
      if (!invocation.heavyCharged) {
        const rate = security.consume("work", subject);
        if (!rate.allowed) throw limited("HTTP work rate limit reached", rate);
        invocation.heavyCharged = true;
      }
      return await work(signal);
    } finally {
      lease.release();
    }
  });
}
