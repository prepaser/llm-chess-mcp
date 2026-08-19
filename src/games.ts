import { randomUUID } from "node:crypto";
import { Chess } from "chess.js";
import { ChessError } from "./errors.js";
import type { GameRecord } from "./types.js";

export const MAX_GAMES = 1_000;
export const GAME_TTL_MS = 60 * 60 * 1_000;

export interface GameStoreOptions {
  maxGames?: number;
  idleTtlMs?: number;
  clock?: () => number;
  createId?: () => string;
}

export class GameStore {
  readonly maxGames: number;
  readonly idleTtlMs: number;

  private readonly games = new Map<string, GameRecord>();
  private readonly clock: () => number;
  private readonly createId: () => string;

  constructor(options: GameStoreOptions = {}) {
    this.maxGames = options.maxGames ?? MAX_GAMES;
    this.idleTtlMs = options.idleTtlMs ?? GAME_TTL_MS;
    this.clock = options.clock ?? Date.now;
    this.createId = options.createId ?? randomUUID;

    if (!Number.isInteger(this.maxGames) || this.maxGames < 1) {
      throw new RangeError("maxGames must be a positive integer");
    }
    if (!Number.isFinite(this.idleTtlMs) || this.idleTtlMs < 0) {
      throw new RangeError("idleTtlMs must be a non-negative number");
    }
  }

  cleanupGames(now = this.clock()): number {
    let removed = 0;
    for (const [id, game] of this.games) {
      if (!this.isExpired(game, now)) continue;
      this.games.delete(id);
      removed += 1;
    }
    return removed;
  }

  createGame(fen?: string): string {
    return this.createGameFromChess(fen === undefined ? new Chess() : new Chess(fen));
  }

  createGameFromChess(chess: Chess): string {
    const now = this.clock();
    this.cleanupGames(now);
    if (this.games.size >= this.maxGames) {
      throw new ChessError(
        "GAME_LIMIT_REACHED",
        `game session limit reached: ${this.maxGames}`,
      );
    }

    const id = this.createId();
    if (this.games.has(id)) {
      throw new ChessError("GAME_ID_COLLISION", `game ID already exists: ${id}`);
    }
    this.games.set(id, { chess, createdAt: now, lastAccessedAt: now, revision: 0 });
    return id;
  }

  getGame(id: string): GameRecord {
    const game = this.games.get(id);
    if (!game) throw new ChessError("GAME_NOT_FOUND", `game not found: ${id}`);

    const now = this.clock();
    if (this.isExpired(game, now)) {
      this.games.delete(id);
      throw new ChessError("GAME_EXPIRED", `game expired: ${id}`);
    }
    game.lastAccessedAt = now;
    return game;
  }

  bumpRevision(id: string): number {
    const game = this.getGame(id);
    game.revision += 1;
    return game.revision;
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
}

export const defaultGameStore = new GameStore();

export const cleanupGames = (now?: number): number =>
  defaultGameStore.cleanupGames(now);

export const createGame = (fen?: string): string => defaultGameStore.createGame(fen);

export const createGameFromChess = (chess: Chess): string =>
  defaultGameStore.createGameFromChess(chess);

export const getGame = (id: string): GameRecord => defaultGameStore.getGame(id);

export const bumpRevision = (id: string): number => defaultGameStore.bumpRevision(id);

export const deleteGame = (id: string): boolean => defaultGameStore.deleteGame(id);

export const listGames = (): string[] => defaultGameStore.listGames();

export const gameCount = (): number => defaultGameStore.gameCount();
