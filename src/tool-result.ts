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

export type ToolErrorResult = ToolResult & { isError: true };

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
): ToolSuccessResult<StructuredContent>;
/** @deprecated Pass structuredContent and summary without a schema. */
export function toolResult<Schema extends z.ZodType>(
  schema: Schema,
  structuredContent: SchemaOutput<Schema>,
  summary: string,
): ToolSuccessResult<SchemaOutput<Schema>>;
export function toolResult(
  schemaOrContent: z.ZodType | Record<string, unknown>,
  contentOrSummary: Record<string, unknown> | string,
  legacySummary?: string,
): ToolSuccessResult<Record<string, unknown>> {
  const legacy = arguments.length === 3;
  const structuredContent = legacy
    ? contentOrSummary as Record<string, unknown>
    : schemaOrContent as Record<string, unknown>;
  const summary = legacy ? legacySummary : contentOrSummary;
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

type JsonSchema = Record<string, unknown>;

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaBranches(schema: JsonSchema, key: string): unknown[] {
  const value = schema[key];
  return Array.isArray(value) ? value : [];
}

function schemaRef(
  schema: JsonSchema,
  definitions: JsonSchema,
): [string, JsonSchema] | undefined {
  if (typeof schema.$ref !== "string") return undefined;
  const match = /^#\/\$defs\/([^/]+)$/.exec(schema.$ref);
  if (!match) return undefined;
  const name = match[1];
  const definition = name === undefined ? undefined : definitions[name];
  return isJsonSchema(definition) ? [schema.$ref, definition] : undefined;
}

function hasNonObjectBranch(
  schema: unknown,
  definitions: JsonSchema,
  seen = new Set<string>(),
): boolean {
  if (!isJsonSchema(schema)) return false;
  const type = schema.type;
  if (typeof type === "string" && type !== "object") return true;
  if (
    Array.isArray(type) &&
    type.some((value) => value !== "object")
  ) {
    return true;
  }

  const branches = ["allOf", "anyOf", "oneOf"].flatMap((key) =>
    schemaBranches(schema, key),
  );
  if (branches.some((branch) => hasNonObjectBranch(branch, definitions, seen))) {
    return true;
  }

  const ref = schemaRef(schema, definitions);
  if (ref) {
    const [key, definition] = ref;
    if (seen.has(key)) return false;
    seen.add(key);
    const result = hasNonObjectBranch(definition, definitions, seen);
    seen.delete(key);
    return result;
  }

  return false;
}

function hasObjectConstraint(
  schema: unknown,
  definitions: JsonSchema,
  seen = new Set<string>(),
): boolean {
  if (!isJsonSchema(schema)) return false;
  const type = schema.type;
  if (type === "object") return true;
  if (Array.isArray(type)) return type.every((value) => value === "object");

  const alternatives = ["anyOf", "oneOf"].flatMap((key) =>
    schemaBranches(schema, key),
  );
  if (alternatives.length > 0) {
    return alternatives.every((branch) =>
      hasObjectConstraint(branch, definitions, seen),
    );
  }

  const allOf = schemaBranches(schema, "allOf");
  if (allOf.length > 0) {
    return allOf.some((branch) =>
      hasObjectConstraint(branch, definitions, seen),
    );
  }

  const ref = schemaRef(schema, definitions);
  if (!ref) return false;
  const [key, definition] = ref;
  if (seen.has(key)) return false;
  seen.add(key);
  const result = hasObjectConstraint(definition, definitions, seen);
  seen.delete(key);
  return result;
}

function assertWireSchema(
  schema: z.ZodType,
  kind: "input" | "output",
): void {
  try {
    const wireSchema = z.toJSONSchema(schema);
    const definitions = isJsonSchema(wireSchema.$defs)
      ? wireSchema.$defs
      : {};
    if (
      hasNonObjectBranch(wireSchema, definitions) ||
      !hasObjectConstraint(wireSchema, definitions)
    ) {
      throw new TypeError(`MCP tool ${kind} schema must have an object root`);
    }
  } catch (cause) {
    throw new TypeError(
      `MCP ${kind} schema must be representable as JSON Schema`,
      { cause },
    );
  }
}

export function safeHandler<
  InputSchema extends z.ZodType<Record<string, unknown>>,
  OutputSchema extends z.ZodType<Record<string, unknown>>,
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
  InputSchema extends z.ZodType<Record<string, unknown>>,
  OutputSchema extends z.ZodType<Record<string, unknown>>,
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
  InputSchema extends z.ZodType<Record<string, unknown>>,
  OutputSchema extends z.ZodType<Record<string, unknown>>,
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
  InputSchema extends z.ZodType<Record<string, unknown>>,
  OutputSchema extends z.ZodType<Record<string, unknown>>,
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
      if (result.isError) return result;
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
