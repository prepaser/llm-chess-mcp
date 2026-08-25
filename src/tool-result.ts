import type { ServerContext } from "@modelcontextprotocol/server";
import type { ExplorerErrorKind } from "./domain.js";
import { ChessError } from "./errors.js";
import { ExplorerError } from "./explorer.js";
import type * as z from "zod/v4";

const UNABORTABLE_SIGNAL = new AbortController().signal;

export type ToolResult<StructuredContent extends Record<string, unknown> = Record<string, unknown>> = {
  content: { type: "text"; text: string }[];
  structuredContent: StructuredContent;
  isError?: boolean;
};

type SchemaOutput<Schema extends z.ZodType> = z.output<Schema> extends Record<
  string,
  unknown
>
  ? z.output<Schema>
  : never;

export function toolResult<Schema extends z.ZodType>(
  _schema: Schema,
  structuredContent: SchemaOutput<Schema>,
  summary: string,
): ToolResult<SchemaOutput<Schema>> {
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

export function safeHandler<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
>(
  inputSchema: InputSchema,
  _outputSchema: OutputSchema,
  handler: (
    args: z.output<InputSchema>,
    signal: AbortSignal,
  ) => Promise<ToolResult<SchemaOutput<OutputSchema>>>,
): (
  args: z.input<InputSchema>,
  context?: ServerContext,
) => Promise<ToolResult> {
  return async (args, context) => {
    const signal = context?.mcpReq.signal ?? UNABORTABLE_SIGNAL;
    try {
      signal.throwIfAborted();
      if (context) return await handler(args as z.output<InputSchema>, signal);

      const parsed = inputSchema.safeParse(args);
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
