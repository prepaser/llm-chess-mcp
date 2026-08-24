import type { ServerContext } from "@modelcontextprotocol/server";
import { ChessError } from "./errors.js";
import { ExplorerError } from "./explorer.js";
import type { ExplorerErrorKind } from "./explorer.js";
import type * as z from "zod/v4";

const UNABORTABLE_SIGNAL = new AbortController().signal;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export function toolResult(
  structuredContent: Record<string, unknown>,
  summary: string,
): ToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

export function toolError(code: string, message: string): ToolResult {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

function explorerErrorCode(kind: ExplorerErrorKind): string {
  return `LICHESS_${kind.toUpperCase()}`;
}

export function safeHandler<Schema extends z.ZodType>(
  schema: Schema,
  handler: (args: z.output<Schema>, signal: AbortSignal) => Promise<ToolResult>,
): (args: z.input<Schema>, context?: ServerContext) => Promise<ToolResult> {
  return async (args, context) => {
    const signal = context?.mcpReq.signal ?? UNABORTABLE_SIGNAL;
    try {
      signal.throwIfAborted();
      if (context) return await handler(args as z.output<Schema>, signal);

      const parsed = schema.safeParse(args);
      if (!parsed.success) return toolError("INVALID_INPUT", "invalid tool input");
      return await handler(parsed.data, signal);
    } catch (error) {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof ChessError) return toolError(error.code, error.message);
      if (error instanceof ExplorerError) {
        return toolError(explorerErrorCode(error.kind), error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      return toolError("INTERNAL", message);
    }
  };
}
