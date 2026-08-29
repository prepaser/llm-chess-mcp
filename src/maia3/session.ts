import type * as ort from "onnxruntime-node";
import { VOCAB_SIZE } from "./vocab.js";

export function assertSessionContract(
  candidate: Pick<ort.InferenceSession, "inputNames" | "outputNames">,
): void {
  for (const name of ["tokens", "self_elo", "oppo_elo"]) {
    if (!candidate.inputNames.includes(name)) {
      throw new Error(`Maia3 model input missing: ${name}`);
    }
  }
  if (!candidate.outputNames.includes("logits_move")) {
    throw new Error("Maia3 model output missing: logits_move");
  }
}

export async function createCheckedSession(
  create: () => Promise<ort.InferenceSession>,
): Promise<ort.InferenceSession> {
  const candidate = await create();
  try {
    assertSessionContract(candidate);
    return candidate;
  } catch (error) {
    try {
      await candidate.release();
    } catch {}
    throw error;
  }
}

export function extractMoveLogits(
  results: ort.InferenceSession.ReturnType,
): Float32Array {
  const tensor = results.logits_move;
  if (!tensor) throw new Error("Maia3 inference output missing: logits_move");
  if (tensor.type !== "float32" || !(tensor.data instanceof Float32Array)) {
    throw new Error(`invalid Maia3 logits type: ${tensor.type}`);
  }
  if (
    tensor.dims.length !== 2 ||
    tensor.dims[0] !== 1 ||
    tensor.dims[1] !== VOCAB_SIZE
  ) {
    throw new Error(`invalid Maia3 logits shape: [${tensor.dims.join(", ")}]`);
  }
  if (tensor.data.length !== VOCAB_SIZE) {
    throw new Error(`invalid Maia3 logits length: ${tensor.data.length}`);
  }
  return tensor.data;
}
