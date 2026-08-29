import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Chess } from "chess.js";
import type { Move } from "chess.js";
import {
  assertLegalPosition,
  assertSafeFenCounters,
  playParsedMove,
  snapshotChess,
} from "./chess.js";
import { ChessError } from "./errors.js";
import type { GameRecord } from "./domain.js";

export const MAX_GAMES = 1_000;
export const GAME_TTL_MS = 60 * 60 * 1_000;
const MAX_GAME_ID_LENGTH = 256;

function monotonicClock(): () => number {
  const origin = Date.now() - performance.now();
  return () => origin + performance.now();
}

export interface GameStoreOptions {
  maxGames?: number;
  idleTtlMs?: number;
  clock?: () => number;
  createId?: () => string;
}

export interface GameSnapshot {
  chess: Chess;
  revision: number;
}

export class GameStore {
  readonly maxGames: number;
  readonly idleTtlMs: number;

  private readonly games = new Map<string, GameRecord>();
  private readonly clock: () => number;
  private readonly createId: () => string;
  private lastClockTime: number | undefined;

  constructor(options: GameStoreOptions = {}) {
    this.maxGames = options.maxGames ?? MAX_GAMES;
    this.idleTtlMs = options.idleTtlMs ?? GAME_TTL_MS;
    this.clock = options.clock ?? monotonicClock();
    this.createId = options.createId ?? randomUUID;

    if (!Number.isInteger(this.maxGames) || this.maxGames < 1) {
      throw new RangeError("maxGames must be a positive integer");
    }
    if (!Number.isFinite(this.idleTtlMs) || this.idleTtlMs < 0) {
      throw new RangeError("idleTtlMs must be a non-negative number");
    }
  }

  cleanupGames(now?: number): number {
    const current =
      now === undefined ? this.clockTime() : this.validateCleanupTime(now);
    return this.cleanupGamesAt(current);
  }

  private cleanupGamesAt(now: number): number {
    let removed = 0;
    for (const [id, game] of this.games) {
      if (!this.isExpired(game, now)) continue;
      this.games.delete(id);
      removed += 1;
    }
    return removed;
  }

  createGame(fen?: string): string {
    if (fen === undefined) return this.createGameFromChess(new Chess());

    assertSafeFenCounters(fen);
    let chess: Chess;
    try {
      chess = new Chess(fen);
    } catch {
      throw new ChessError("INVALID_FEN", "invalid FEN");
    }
    return this.createGameFromChess(chess);
  }

  createGameFromChess(chess: Chess): string {
    assertLegalPosition(chess);
    const now = this.clockTime();
    this.cleanupGamesAt(now);
    if (this.games.size >= this.maxGames) {
      throw new ChessError(
        "GAME_LIMIT_REACHED",
        `game session limit reached: ${this.maxGames}`,
      );
    }

    const id = this.createId();
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_GAME_ID_LENGTH
    ) {
      throw new ChessError(
        "GAME_ID_GENERATION_FAILED",
        `game ID must be a non-empty string of at most ${MAX_GAME_ID_LENGTH} characters`,
      );
    }
    if (this.games.has(id)) {
      throw new ChessError("GAME_ID_COLLISION", `game ID already exists: ${id}`);
    }
    const snapshot = snapshotChess(chess);
    if (this.games.size >= this.maxGames) {
      throw new ChessError(
        "GAME_LIMIT_REACHED",
        `game session limit reached: ${this.maxGames}`,
      );
    }
    if (this.games.has(id)) {
      throw new ChessError("GAME_ID_COLLISION", `game ID already exists: ${id}`);
    }
    this.games.set(id, {
      chess: snapshot,
      createdAt: now,
      lastAccessedAt: now,
      revision: 0,
    });
    return id;
  }

  getSnapshot(id: string): GameSnapshot {
    const game = this.getLiveGame(id);
    return { chess: snapshotChess(game.chess), revision: game.revision };
  }

  applyMove(id: string, expectedRevision: number, move: Move): GameSnapshot {
    const promotion = move.promotion;
    const materialized = {
      from: move.from,
      to: move.to,
      ...(promotion ? { promotion } : {}),
    } as Move;
    const game = this.getLiveGame(id);
    if (expectedRevision !== game.revision) {
      throw new ChessError(
        "STALE_POSITION",
        `position changed: expected revision ${expectedRevision}, current ${game.revision}`,
      );
    }
    let applied = false;
    try {
      playParsedMove(game.chess, materialized);
      applied = true;
      assertSafeFenCounters(game.chess.fen());
      const chess = snapshotChess(game.chess);
      game.revision += 1;
      return { chess, revision: game.revision };
    } catch (error) {
      if (applied) game.chess.undo();
      throw error;
    }
  }

  private getLiveGame(id: string): GameRecord {
    const game = this.games.get(id);
    if (!game) throw new ChessError("GAME_NOT_FOUND", `game not found: ${id}`);

    const now = this.clockTime();
    if (this.isExpired(game, now)) {
      this.games.delete(id);
      throw new ChessError("GAME_EXPIRED", `game expired: ${id}`);
    }
    game.lastAccessedAt = now;
    return game;
  }

  deleteGame(id: string): boolean {
    this.cleanupGames();
    return this.games.delete(id);
  }

  listGames(): string[] {
    this.cleanupGames();
    return [...this.games.keys()];
  }

  gameCount(): number {
    this.cleanupGames();
    return this.games.size;
  }

  private isExpired(game: GameRecord, now: number): boolean {
    return now - game.lastAccessedAt >= this.idleTtlMs;
  }

  private clockTime(): number {
    return this.validateClockTime(this.clock());
  }

  private validateCleanupTime(now: number): number {
    this.assertSafeClockTime(now);
    return now;
  }

  private validateClockTime(now: number): number {
    this.assertSafeClockTime(now);
    if (this.lastClockTime !== undefined && now < this.lastClockTime) {
      throw new RangeError("clock must return finite, safe, monotonic time");
    }
    this.lastClockTime = now;
    return now;
  }

  private assertSafeClockTime(now: number): void {
    if (!Number.isFinite(now) || Math.abs(now) > Number.MAX_SAFE_INTEGER) {
      throw new RangeError("clock must return finite, safe, monotonic time");
    }
  }
}

export const defaultGameStore = new GameStore();
