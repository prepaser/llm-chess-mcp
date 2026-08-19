import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Chess } from "chess.js";
import { ChessError } from "../src/errors.js";
import {
  GAME_TTL_MS,
  GameStore,
  MAX_GAMES,
  cleanupGames,
  createGame,
  createGameFromChess,
  deleteGame,
  gameCount,
  getGame,
  listGames,
} from "../src/games.js";

afterEach(() => {
  for (const id of listGames()) deleteGame(id);
});

function expectChessError(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof ChessError && error.code === code);
}

test("expires an idle game with GAME_EXPIRED", () => {
  const id = createGame();
  getGame(id).lastAccessedAt = Date.now() - GAME_TTL_MS;

  expectChessError("GAME_EXPIRED", () => getGame(id));
  expectChessError("GAME_NOT_FOUND", () => getGame(id));
});

test("cleans up expired games without a timer", () => {
  const id = createGame();
  getGame(id).lastAccessedAt = Date.now() - GAME_TTL_MS;

  assert.equal(cleanupGames(), 1);
  assert.equal(gameCount(), 0);
});

test("active access refreshes the idle deadline", () => {
  const id = createGame();
  const game = getGame(id);
  game.lastAccessedAt = Date.now() - GAME_TTL_MS + 1;

  assert.equal(getGame(id), game);
  assert.ok(game.lastAccessedAt > Date.now() - 1_000);
});

test("rejects a new game when the session limit is reached", () => {
  for (let i = 0; i < MAX_GAMES; i += 1) createGameFromChess(new Chess());

  expectChessError("GAME_LIMIT_REACHED", () => createGame());
  assert.equal(gameCount(), MAX_GAMES);
});

test("GameStore accepts deterministic clocks and IDs", () => {
  let now = 100;
  let nextId = 0;
  const store = new GameStore({
    maxGames: 2,
    idleTtlMs: 10,
    clock: () => now,
    createId: () => `game-${nextId++}`,
  });

  const first = store.createGame();
  assert.equal(first, "game-0");
  assert.deepEqual(store.listGames(), [first]);
  assert.equal(store.getGame(first).lastAccessedAt, 100);

  now = 109;
  assert.equal(store.getGame(first).lastAccessedAt, 109);
  now = 118;
  assert.equal(store.cleanupGames(), 0);
  now = 119;
  assert.equal(store.cleanupGames(), 1);
});

test("GameStore isolates game collections", () => {
  const left = new GameStore({ createId: () => "left" });
  const right = new GameStore({ createId: () => "right" });

  left.createGame();
  right.createGame();

  assert.deepEqual(left.listGames(), ["left"]);
  assert.deepEqual(right.listGames(), ["right"]);
});

test("GameStore validates limits and rejects duplicate IDs", () => {
  assert.throws(() => new GameStore({ maxGames: 0 }), RangeError);
  assert.throws(() => new GameStore({ idleTtlMs: -1 }), RangeError);

  const store = new GameStore({ maxGames: 2, createId: () => "same" });
  store.createGame();
  expectChessError("GAME_ID_COLLISION", () => store.createGame());
});
