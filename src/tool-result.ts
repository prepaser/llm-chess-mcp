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
  _schema: Schema,
  handler: (args: z.output<Schema>) => Promise<ToolResult>,
): (args: z.output<Schema>) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof ChessError) return toolError(error.code, error.message);
      if (error instanceof ExplorerError) {
        return toolError(explorerErrorCode(error.kind), error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      return toolError("INTERNAL", message);
    }
  };
}
import { ExplorerError } from "./explorer.js";
import type { ExplorerErrorKind } from "./explorer.js";
import { ChessError } from "./errors.js";
import type * as z from "zod/v4";
