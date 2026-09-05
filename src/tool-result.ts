import type { ServerContext } from "@modelcontextprotocol/server";
import type { ExplorerErrorKind } from "./domain.js";
import { ChessError } from "./errors.js";
import { ExplorerError } from "./explorer.js";
import * as z from "zod/v4";

const UNABORTABLE_SIGNAL = new AbortController().signal;
const INTERNAL_ERROR_MESSAGE = "internal tool error";

export type ToolResult<StructuredContent extends Record<string, unknown> = Record<string, unknown>> = {
  content: { type: "text"; text: string }[];
  structuredContent: StructuredContent;
  isError?: boolean;
};

type ToolSuccessResult<StructuredContent extends Record<string, unknown>> =
  ToolResult<StructuredContent> & { isError?: false | undefined };

export type ToolErrorResult = {
  content: { type: "text"; text: string }[];
  structuredContent: { error: { code: string; message: string } };
  isError: true;
};

type ToolHandlerResult<StructuredContent extends Record<string, unknown>> =
  | ToolSuccessResult<StructuredContent>
  | ToolErrorResult;

type SchemaOutput<Schema extends z.ZodType> = z.output<Schema> extends Record<
  string,
  unknown
>
  ? z.output<Schema>
  : never;

export function toolResult<StructuredContent extends Record<string, unknown>>(
  structuredContent: StructuredContent,
  summary: string,
): ToolSuccessResult<StructuredContent> {
  if (typeof summary !== "string") {
    throw new TypeError("tool result summary must be a string");
  }
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
  };
}

export function toolError(code: string, message: string): ToolErrorResult {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

function explorerErrorCode(kind: ExplorerErrorKind): string {
  return `LICHESS_${kind.toUpperCase()}`;
}

const ToolErrorSchema = z.strictObject({
  content: z.array(z.strictObject({ type: z.literal("text"), text: z.string() })).min(1),
  structuredContent: z.strictObject({
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
  isError: z.literal(true),
});

function assertWireSchema(schema: z.ZodType, kind: "input" | "output"): void {
  try {
    if (!(schema instanceof z.ZodObject)) {
      throw new TypeError("tool schemas must be Zod objects");
    }
    const wire = z.toJSONSchema(schema);
    if (wire.type !== "object") throw new TypeError("tool schemas must have an object root");
  } catch (cause) {
    throw new TypeError(
      `MCP ${kind} schema must be representable as JSON Schema`,
      { cause },
    );
  }
}

export function safeHandler<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodObject,
>(
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: (
    args: z.output<InputSchema>,
    signal: AbortSignal,
  ) => Promise<ToolSuccessResult<SchemaOutput<OutputSchema>>>,
): (
  args: z.input<InputSchema>,
  context?: ServerContext,
) => Promise<ToolResult>;
export function safeHandler<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodObject,
>(
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: (
    args: z.output<InputSchema>,
    signal: AbortSignal,
  ) => Promise<ToolErrorResult>,
): (
  args: z.input<InputSchema>,
  context?: ServerContext,
) => Promise<ToolResult>;
export function safeHandler<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodObject,
>(
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: (
    args: z.output<InputSchema>,
    signal: AbortSignal,
  ) => Promise<ToolHandlerResult<SchemaOutput<OutputSchema>>>,
): (
  args: z.input<InputSchema>,
  context?: ServerContext,
) => Promise<ToolResult>;
export function safeHandler<
  InputSchema extends z.ZodObject,
  OutputSchema extends z.ZodObject,
>(
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: (
    args: z.output<InputSchema>,
    signal: AbortSignal,
  ) => Promise<ToolHandlerResult<SchemaOutput<OutputSchema>>>,
): (
  args: z.input<InputSchema>,
  context?: ServerContext,
) => Promise<ToolResult> {
  assertWireSchema(inputSchema, "input");
  assertWireSchema(outputSchema, "output");
  return async (args, context) => {
    const signal = context?.mcpReq.signal ?? UNABORTABLE_SIGNAL;
    try {
      signal.throwIfAborted();
      const parsedInput = await inputSchema.safeParseAsync(args);
      signal.throwIfAborted();
      if (!parsedInput.success) {
        return toolError("INVALID_INPUT", "invalid tool input");
      }
      const result = await handler(parsedInput.data, signal);
      signal.throwIfAborted();
      if (result.isError !== undefined && typeof result.isError !== "boolean") {
        throw new TypeError("tool result isError must be a boolean");
      }
      if (result.isError === true) {
        if (!ToolErrorSchema.safeParse(result).success) {
          throw new TypeError("invalid tool error result");
        }
        return result;
      }
      const parsed = await outputSchema.safeParseAsync(result.structuredContent);
      if (!parsed.success) throw new Error("invalid tool output");
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      if (error instanceof ChessError) return toolError(error.code, error.message);
      if (error instanceof ExplorerError) {
        return toolError(explorerErrorCode(error.kind), error.message);
      }
      return toolError("INTERNAL", INTERNAL_ERROR_MESSAGE);
    }
  };
}
