import { parentPort } from "node:worker_threads";
import * as ort from "onnxruntime-node";
import { createCheckedSession, extractMoveLogits } from "./session.js";

export type MaiaWorkerRequest = {
  type: "run";
  id: number;
  modelPath: string;
  input: Float32Array;
  elo: number;
  oppoElo: number;
};

export type MaiaWorkerResponse =
  | { id: number; ok: true; logits: Float32Array }
  | {
      id: number;
      ok: false;
      error: { name: string; message: string; stack?: string };
    };

const port = parentPort;
if (!port) throw new Error("Maia3 inference worker requires a parent port");

let session: ort.InferenceSession | null = null;
let sessionPath: string | null = null;

async function getSession(modelPath: string): Promise<ort.InferenceSession> {
  if (session && sessionPath === modelPath) return session;
  if (session) {
    const previous = session;
    session = null;
    sessionPath = null;
    await previous.release();
  }
  const created = await createCheckedSession(() =>
    ort.InferenceSession.create(modelPath),
  );
  session = created;
  sessionPath = modelPath;
  return created;
}

function serializeError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}

port.on("message", (request: MaiaWorkerRequest) => {
  void (async () => {
    try {
      const current = await getSession(request.modelPath);
      const tokens = new ort.Tensor("float32", request.input, [1, 64, 96]);
      const selfElo = new ort.Tensor(
        "int64",
        BigInt64Array.from([BigInt(request.elo)]),
        [1],
      );
      const oppoElo = new ort.Tensor(
        "int64",
        BigInt64Array.from([BigInt(request.oppoElo)]),
        [1],
      );
      const results = await current.run({
        tokens,
        self_elo: selfElo,
        oppo_elo: oppoElo,
      });
      const logits = new Float32Array(extractMoveLogits(results));
      const response: MaiaWorkerResponse = { id: request.id, ok: true, logits };
      port.postMessage(response, [logits.buffer as ArrayBuffer]);
    } catch (error) {
      const response: MaiaWorkerResponse = {
        id: request.id,
        ok: false,
        error: serializeError(error),
      };
      port.postMessage(response);
    }
  })();
});
