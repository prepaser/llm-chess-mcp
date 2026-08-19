import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../dist/server.js";

const CONTRACT_PATH = new URL("../spec/tools.json", import.meta.url);

function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sort(child)]),
  );
}

async function currentContract() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  const client = new Client({ name: "contract-generator", version: "1" });
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    return sort({
      tools: tools
        .map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          outputSchema,
          annotations,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } finally {
    await client.close();
    await server.close();
  }
}

const serialized = `${JSON.stringify(await currentContract(), null, 2)}\n`;
if (process.argv.includes("--write")) {
  await mkdir(new URL("../spec/", import.meta.url), { recursive: true });
  await writeFile(CONTRACT_PATH, serialized);
} else {
  const expected = await readFile(CONTRACT_PATH, "utf8");
  assert.equal(
    serialized,
    expected,
    "MCP tool contract changed; run `pnpm contract:update` and review spec/tools.json",
  );
}
