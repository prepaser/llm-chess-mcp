import { Chess } from "chess.js";
import * as ort from "onnxruntime-node";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildInput } from "./tokenize.js";
import { VOCAB_SIZE, vocabIndex } from "./vocab.js";
import { mirrorMove } from "./mirror.js";
import type { Maia3Move } from "../types.js";

let session: ort.InferenceSession | null = null;
let sessionPromise: Promise<ort.InferenceSession> | null = null;
const MODEL_KEYS = new Set(["3m", "5m", "23m", "79m"]);

function modelPath(): string {
  const modelKey = process.env.MAIA3_MODEL || "5m";
  if (!MODEL_KEYS.has(modelKey)) throw new Error(`unsupported Maia3 model: ${modelKey}`);
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../models", `maia3-${modelKey}.onnx`),
    resolve(process.cwd(), "models", `maia3-${modelKey}.onnx`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `maia3 model not found (models/maia3-${modelKey}.onnx). Run \`pnpm export:maia3\` first.`,
  );
}

async function getSession(): Promise<ort.InferenceSession> {
  if (session) return session;
  if (sessionPromise) return sessionPromise;
  sessionPromise = ort.InferenceSession.create(modelPath())
    .then((s) => {
      try {
        assertSessionContract(s);
      } catch (error) {
        s.release();
        throw error;
      }
      session = s;
      return s;
    })
    .catch((error) => {
      sessionPromise = null;
      throw error;
    });
  return sessionPromise;
}

export function assertSessionContract(
  candidate: Pick<ort.InferenceSession, "inputNames" | "outputNames">,
): void {
  for (const name of ["tokens", "self_elo", "oppo_elo"]) {
    if (!candidate.inputNames.includes(name)) throw new Error(`Maia3 model input missing: ${name}`);
  }
  if (!candidate.outputNames.includes("logits_move")) {
    throw new Error("Maia3 model output missing: logits_move");
  }
}

export function extractMoveLogits(results: ort.InferenceSession.ReturnType): Float32Array {
  const tensor = results.logits_move;
  if (!tensor) throw new Error("Maia3 inference output missing: logits_move");
  if (tensor.type !== "float32" || !(tensor.data instanceof Float32Array)) {
    throw new Error(`invalid Maia3 logits type: ${tensor.type}`);
  }
  if (tensor.dims.length !== 2 || tensor.dims[0] !== 1 || tensor.dims[1] !== VOCAB_SIZE) {
    throw new Error(`invalid Maia3 logits shape: [${tensor.dims.join(", ")}]`);
  }
  if (tensor.data.length !== VOCAB_SIZE) {
    throw new Error(`invalid Maia3 logits length: ${tensor.data.length}`);
  }
  return tensor.data;
}

export function softmax(logits: Float32Array): Float32Array {
  if (logits.length === 0) throw new Error("cannot normalize empty logits");
  let max = -Infinity;
  for (const logit of logits) {
    if (Number.isNaN(logit) || logit === Infinity) throw new Error("invalid Maia3 logits");
    if (logit > max) max = logit;
  }
  if (!Number.isFinite(max)) throw new Error("Maia3 logits contain no legal moves");

  let sum = 0;
  const out = new Float32Array(logits.length);
  for (const [i, logit] of logits.entries()) {
    const probability = Math.fround(Math.exp(logit - max));
    out[i] = probability;
    sum += probability;
  }
  out.forEach((value, i) => {
    out[i] = value / sum;
  });
  return out;
}

function valueAt(values: Float32Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Maia3 logits index out of range: ${index}`);
  return value;
}

export async function humanMoveDistribution(
  chess: Chess,
  elo: number,
  oppoElo: number,
  topN: number,
  signal?: AbortSignal,
): Promise<Maia3Move[]> {
  signal?.throwIfAborted();
  if (chess.isGameOver()) return [];
  const legal = chess.moves({ verbose: true });
  if (legal.length === 0) return [];
  const s = await getSession();
  signal?.throwIfAborted();

  const input = buildInput(chess);
  const tokens = new ort.Tensor("float32", input, [1, 64, 96]);
  const selfElo = new ort.Tensor("int64", BigInt64Array.from([BigInt(elo)]), [1]);
  const oppoEloTensor = new ort.Tensor("int64", BigInt64Array.from([BigInt(oppoElo)]), [1]);

  const feeds = { tokens, self_elo: selfElo, oppo_elo: oppoEloTensor };
  const results = await s.run(feeds);
  signal?.throwIfAborted();
  const logits = extractMoveLogits(results);

  signal?.throwIfAborted();
  const turn = chess.turn();
  const legalMask = new Float32Array(logits.length).fill(-Infinity);
  for (const m of legal) {
    const uci = turn === "w" ? m.lan : mirrorMove(m.lan);
    const idx = vocabIndex(uci);
    legalMask[idx] = valueAt(logits, idx);
  }

  const probs = softmax(legalMask);
  const ranked = legal
    .map((m) => {
      const uci = turn === "w" ? m.lan : mirrorMove(m.lan);
      return { uci: m.lan, san: m.san, prob: valueAt(probs, vocabIndex(uci)) };
    })
    .sort((a, b) => b.prob - a.prob);

  signal?.throwIfAborted();
  return ranked.slice(0, topN);
}
