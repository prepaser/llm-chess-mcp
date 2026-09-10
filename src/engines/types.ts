import type { Chess } from "chess.js";
import type { SfLine } from "../domain.js";

export type EngineId = "stockfish" | "lc0";
export type EngineMode = EngineId | "both";
export type EngineLine = SfLine;

export type EngineRequest = {
  mode?: EngineMode;
  depth: number;
  multipv: number;
  movetimeMs: number;
};

export type EngineMeta = {
  id: EngineId;
  version: string;
  weightsSha256: string | null;
  backend: string;
};

export type EngineOutcome<T> =
  | {
      status: "ok";
      meta: EngineMeta;
      result: T;
      elapsedMs: number;
      limits: {
        depth: number | null;
        movetimeMs: number | null;
        multipv: number;
      };
    }
  | {
      status: "error";
      error: { code: string; message: string };
    }
  | { status: "not_requested" };

export type EngineAnalysis = {
  mode: EngineMode;
  partial: boolean;
  enginesUsed: EngineId[];
  engines: Record<EngineId, EngineOutcome<EngineLine[]>>;
};

export type EngineAnalyzer = {
  analyzeEngines(
    chess: Chess,
    request: EngineRequest,
    signal?: AbortSignal,
  ): Promise<EngineAnalysis>;
  quitEngines(): Promise<void>;
};
