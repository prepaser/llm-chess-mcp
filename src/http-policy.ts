import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalHttpPath } from "./http-config.js";
import { hasUnexpectedBody } from "./http-body.js";
import { closeWithError } from "./http-response.js";
import { BearerAuthenticator } from "./http-auth.js";
import { resolveClientIp, TrustedProxySet } from "./http-address.js";
import { HttpSecurity } from "./http-rate-limit.js";
import type { RateLimitDecision, SecuritySubject } from "./http-rate-limit.js";

export function requestPath(req: IncomingMessage): string | null {
  const raw = req.url;
  if (raw === undefined) return null;
  const queryIndex = raw.search(/[?#]/);
  return canonicalHttpPath(queryIndex === -1 ? raw : raw.slice(0, queryIndex));
}

export function sessionId(req: IncomingMessage): string | null | undefined {
  const value = req.headers["mcp-session-id"];
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function rateError(req: IncomingMessage, res: ServerResponse, decision: RateLimitDecision): void {
  closeWithError(req, res, 429, "HTTP rate limit reached", {
    "retry-after": String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))),
  });
}

export class HttpRequestPolicy {
  constructor(
    private readonly path: string,
    private readonly security: HttpSecurity,
    private readonly auth: BearerAuthenticator,
    private readonly proxies: TrustedProxySet,
  ) {}

  admit(req: IncomingMessage, res: ServerResponse): { subject: SecuritySubject; controlOnly?: RateLimitDecision } | undefined {
    let controlOnly: RateLimitDecision | undefined;
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-expose-headers", "Mcp-Session-Id, MCP-Protocol-Version, Retry-After");
    let ip: string;
    try {
      ip = resolveClientIp(req.socket.remoteAddress ?? "", req.headers["x-forwarded-for"], this.proxies).key;
    } catch {
      const peer = req.socket.remoteAddress ?? "unknown";
      const admission = this.security.consume("request", { ip: peer });
      if (!admission.allowed) rateError(req, res, admission);
      else closeWithError(req, res, 400, "invalid forwarded client address");
      return;
    }
    const kind = req.method === "DELETE" ? "control" : "request";
    const admission = this.security.consume(kind, { ip });
    if (req.method === "OPTIONS") {
      if (!admission.allowed) rateError(req, res, admission);
      else if (requestPath(req) !== this.path) closeWithError(req, res, 404, "MCP endpoint not found");
      else if (hasUnexpectedBody(req)) closeWithError(req, res, 400, "OPTIONS must not include a body");
      else {
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
          "access-control-max-age": "600",
        });
        res.end();
      }
      return;
    }
    let prechargedControl = false;
    if (!admission.allowed) {
      if (req.method !== "POST" || !sessionId(req) || requestPath(req) !== this.path) {
        rateError(req, res, admission);
        return;
      }
      const control = this.security.consume("control", { ip });
      if (!control.allowed) {
        rateError(req, res, control);
        return;
      }
      prechargedControl = true;
    }
    const headers = req.headersDistinct.authorization;
    const authenticated = this.auth.authenticate(headers && headers.length > 1 ? headers : req.headers.authorization);
    if (!authenticated.ok) {
      const failure = this.security.consume("authFailure", { ip });
      if (!admission.allowed) rateError(req, res, admission);
      else if (!failure.allowed) rateError(req, res, failure);
      else closeWithError(req, res, 401, "Bearer authentication required", { "www-authenticate": 'Bearer realm="mcp"' });
      return;
    }
    const subject: SecuritySubject = { ip, ...(authenticated.identity ? { bearer: authenticated.identity.digest } : {}) };
    const bearerAdmission = authenticated.identity
      ? this.security.consume(kind, subject, 1, ["bearer"])
      : { allowed: true, retryAfterMs: 0 };
    const denied = !admission.allowed ? admission : !bearerAdmission.allowed ? bearerAdmission : undefined;
    if (denied) {
      if (req.method !== "POST" || !sessionId(req) || requestPath(req) !== this.path) {
        rateError(req, res, denied);
        return;
      }
      const control = this.security.consume("control", subject, 1, prechargedControl ? ["bearer"] : undefined);
      if (!control.allowed) {
        rateError(req, res, control);
        return;
      }
      controlOnly = denied;
    }
    return { subject, ...(controlOnly ? { controlOnly } : {}) };
  }
}
