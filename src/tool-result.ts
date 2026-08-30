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
  definitions: Record<string, unknown>,
): [string, unknown] | undefined {
  if (typeof schema.$ref !== "string") return undefined;
  const prefix = "#/$defs/";
  if (!schema.$ref.startsWith(prefix)) return undefined;
  const name = schema.$ref.slice(prefix.length);
  if (Object.hasOwn(definitions, name)) return [schema.$ref, definitions[name]];
  const decoded = name.replaceAll("~1", "/").replaceAll("~0", "~");
  return Object.hasOwn(definitions, decoded)
    ? [schema.$ref, definitions[decoded]]
    : undefined;
}

type SchemaPossibilities = {
  object: boolean;
  nonObject: boolean;
};

const IMPOSSIBLE_SCHEMA: SchemaPossibilities = {
  object: false,
  nonObject: false,
};
const UNKNOWN_SCHEMA: SchemaPossibilities = {
  object: true,
  nonObject: true,
};

function allOfPossibilities(
  values: readonly SchemaPossibilities[],
): SchemaPossibilities {
  return {
    object: values.every((value) => value.object),
    nonObject: values.every((value) => value.nonObject),
  };
}

function unionPossibilities(
  values: readonly SchemaPossibilities[],
): SchemaPossibilities {
  return {
    object: values.some((value) => value.object),
    nonObject: values.some((value) => value.nonObject),
  };
}

function isFalseSchema(schema: JsonSchema): boolean {
  return (
    Object.keys(schema).length === 1 &&
    isJsonSchema(schema.not) &&
    Object.keys(schema.not).length === 0
  );
}

function schemaPossibilities(
  schema: unknown,
  definitions: Record<string, unknown>,
  seen = new Set<string>(),
): SchemaPossibilities {
  if (schema === false) return IMPOSSIBLE_SCHEMA;
  if (schema === true || !isJsonSchema(schema)) return UNKNOWN_SCHEMA;
  if (isFalseSchema(schema)) return IMPOSSIBLE_SCHEMA;

  const type = schema.type;
  const base =
    type === "object"
      ? { object: true, nonObject: false }
      : typeof type === "string"
        ? { object: false, nonObject: true }
        : Array.isArray(type)
          ? {
              object: type.includes("object"),
              nonObject: type.some((value) => value !== "object"),
            }
          : UNKNOWN_SCHEMA;

  const constraints = [base];
  const allOf = schemaBranches(schema, "allOf");
  if (allOf.length > 0) {
    constraints.push(
      allOfPossibilities(
        allOf.map((branch) => schemaPossibilities(branch, definitions, seen)),
      ),
    );
  }

  const alternatives = ["anyOf", "oneOf"].flatMap((key) =>
    schemaBranches(schema, key),
  );
  if (alternatives.length > 0) {
    constraints.push(
      unionPossibilities(
        alternatives.map((branch) =>
          schemaPossibilities(branch, definitions, seen),
        ),
      ),
    );
  }

  const ref = schemaRef(schema, definitions);
  if (ref) {
    const [key, definition] = ref;
    if (seen.has(key)) return UNKNOWN_SCHEMA;
    seen.add(key);
    const result = schemaPossibilities(definition, definitions, seen);
    seen.delete(key);
    constraints.push(result);
  }

  return allOfPossibilities(constraints);
}

function assertWireSchema(
  schema: z.ZodType,
  kind: "input" | "output",
): void {
  try {
    const wireSchema = z.toJSONSchema(schema);
    const definitions: Record<string, unknown> = isJsonSchema(wireSchema.$defs)
      ? wireSchema.$defs
      : {};
    const possible = schemaPossibilities(wireSchema, definitions);
    if (!possible.object || possible.nonObject) {
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
