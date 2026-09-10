import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MultiEngineCandidateSchema, MoveSensitivitySchema } from "../src/tool-schemas.js";

test("README candidate examples match the current engine schemas", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.split("## Candidate structure\n")[1]?.split("## Analysis levels")[0];
  assert.ok(section);
  const examples = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!));
  assert.equal(examples.length, 2);
  MultiEngineCandidateSchema.parse(examples[0]);
  assert.deepEqual(Object.keys(examples[1].moveSensitivity).sort(), ["lc0", "stockfish"]);
  for (const engine of ["stockfish", "lc0"]) {
    MoveSensitivitySchema.parse(examples[1].moveSensitivity[engine]);
  }
});
