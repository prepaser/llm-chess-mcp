import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { MAX_EVALUATED_MOVES } from "../src/chess.js";
import {
  MAX_ANALYSIS_DEPTH,
  MAX_HUMAN_MOVES,
  MAX_MULTIPV,
} from "../src/domain.js";
import { TOOL_INPUT_SCHEMAS } from "../src/tool-inputs.js";

const validInputs = {
  create_game: {},
  delete_game: { game_id: "game" },
  game_state: { game_id: "game" },
  game_play_move: { game_id: "game", move: "e4", expected_revision: 0 },
  game_legal_moves: { game_id: "game" },
  position_analyze: { game_id: "game" },
  human_move_distribution: { game_id: "game" },
  move_evaluate: { game_id: "game", move: "e4" },
  move_candidates: { game_id: "game" },
  move_candidates_by_intent: { game_id: "game", intent: "best" },
  opening_explorer: { game_id: "game" },
  game_pgn: { game_id: "game" },
  game_import_pgn: { pgn: "1. e4 *" },
} as const;

test("tool input schemas reject unknown top-level arguments", () => {
  for (const [name, input] of Object.entries(validInputs)) {
    const schema = TOOL_INPUT_SCHEMAS[name as keyof typeof TOOL_INPUT_SCHEMAS] as z.ZodType;
    assert.equal(schema.safeParse(input).success, true, name);
    assert.equal(
      schema.safeParse({ ...input, unexpected: true }).success,
      false,
      name,
    );
    const wireSchema = z.toJSONSchema(schema) as { additionalProperties?: boolean };
    assert.equal(wireSchema.additionalProperties, false, name);
  }
});

test("masters filter constraints share runtime and wire behavior", () => {
  const schema = TOOL_INPUT_SCHEMAS.opening_explorer;
  assert.equal(
    schema.safeParse({ game_id: "game", db: "masters", speeds: ["rapid"] }).success,
    false,
  );
  const wireSchema = z.toJSONSchema(schema) as {
    allOf?: Array<{ then?: { properties?: { speeds?: { maxItems?: number } } } }>;
  };
  assert.equal(wireSchema.allOf?.[0]?.then?.properties?.speeds?.maxItems, 0);
});

test("every game-id input enforces the shared length bounds", () => {
  for (const [name, input] of Object.entries(validInputs)) {
    if (!("game_id" in input)) continue;
    const schema = TOOL_INPUT_SCHEMAS[
      name as keyof typeof TOOL_INPUT_SCHEMAS
    ] as z.ZodType;
    assert.equal(schema.safeParse({ ...input, game_id: "g".repeat(256) }).success, true, name);
    assert.equal(schema.safeParse({ ...input, game_id: "😀".repeat(256) }).success, true, name);
    assert.equal(schema.safeParse({ ...input, game_id: "" }).success, false, name);
    assert.equal(
      schema.safeParse({ ...input, game_id: "g".repeat(257) }).success,
      false,
      name,
    );
    assert.equal(
      schema.safeParse({ ...input, game_id: "😀".repeat(257) }).success,
      false,
      name,
    );
    const wire = z.toJSONSchema(schema) as {
      properties?: Record<string, { maxLength?: number; minLength?: number }>;
    };
    assert.equal(wire.properties?.game_id?.minLength, 1, name);
    assert.equal(wire.properties?.game_id?.maxLength, 256, name);
  }
});

test("analysis and move inputs expose the shared limits", () => {
  type Property = { maximum?: number };
  const properties = (schema: z.ZodType) =>
    (z.toJSONSchema(schema) as { properties?: Record<string, Property> })
      .properties ?? {};

  const position = properties(TOOL_INPUT_SCHEMAS.position_analyze);
  assert.equal(position.depth?.maximum, MAX_ANALYSIS_DEPTH);
  assert.equal(position.multipv?.maximum, MAX_MULTIPV);

  const evaluation = z.toJSONSchema(TOOL_INPUT_SCHEMAS.move_evaluate) as {
    properties?: Record<string, Property & { anyOf?: Array<{ maxItems?: number }> }>;
  };
  assert.equal(evaluation.properties?.depth?.maximum, MAX_ANALYSIS_DEPTH);
  assert.equal(
    evaluation.properties?.move?.anyOf?.[1]?.maxItems,
    MAX_EVALUATED_MOVES,
  );

  for (const schema of [
    TOOL_INPUT_SCHEMAS.move_candidates,
    TOOL_INPUT_SCHEMAS.move_candidates_by_intent,
  ]) {
    const candidate = properties(schema);
    assert.equal(candidate.sf_depth?.maximum, MAX_ANALYSIS_DEPTH);
    assert.equal(candidate.sf_multipv?.maximum, MAX_MULTIPV);
    assert.equal(candidate.maia_top_n?.maximum, MAX_HUMAN_MOVES);
  }
});
