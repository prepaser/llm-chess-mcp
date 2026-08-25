import assert from "node:assert/strict";
import test from "node:test";
import { OpeningStatsSchema } from "../src/tool-schemas.js";

const values = {
  games: null,
  frequency: null,
  white: null,
  draws: null,
  black: null,
  averageRating: null,
};

test("opening stats enforce status-specific failure reasons", () => {
  assert.equal(
    OpeningStatsSchema.safeParse({ status: "unavailable", ...values }).success,
    false,
  );
  assert.equal(
    OpeningStatsSchema.safeParse({
      status: "available",
      reason: "network",
      ...values,
    }).success,
    false,
  );
  assert.equal(
    OpeningStatsSchema.safeParse({
      status: "unavailable",
      reason: "network",
      ...values,
    }).success,
    true,
  );
  for (const status of ["available", "no_data", "disabled"] as const) {
    assert.equal(OpeningStatsSchema.safeParse({ status, ...values }).success, true);
  }
});
