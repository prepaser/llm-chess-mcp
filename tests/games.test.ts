import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { parseMove } from "../src/chess.js";
import { ChessError } from "../src/errors.js";
import {
  GAME_TTL_MS,
  GameStore,
  MAX_GAMES,
} from "../src/games.js";

function expectChessError(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof ChessError && error.code === code);
}

test("expires an idle game with GAME_EXPIRED", () => {
  let now = 0;
  const store = new GameStore({ clock: () => now });
  const id = store.createGame();
  now = GAME_TTL_MS;

  expectChessError("GAME_EXPIRED", () => store.getSnapshot(id));
  expectChessError("GAME_NOT_FOUND", () => store.getSnapshot(id));
});

test("cleans up expired games without a timer", () => {
  let now = 0;
  const store = new GameStore({ clock: () => now });
  store.createGame();
  now = GAME_TTL_MS;

  assert.equal(store.cleanupGames(), 1);
  assert.equal(store.gameCount(), 0);
});

test("active access refreshes the idle deadline", () => {
  let now = 0;
  const store = new GameStore({ clock: () => now });
  const id = store.createGame();
  now = GAME_TTL_MS - 1;

  assert.equal(store.getSnapshot(id).revision, 0);
  now = GAME_TTL_MS;
  assert.equal(store.getSnapshot(id).revision, 0);
});

test("rejects a new game when the session limit is reached", () => {
  const store = new GameStore({ createId: (() => {
    let id = 0;
    return () => `game-${id++}`;
  })() });
  for (let i = 0; i < MAX_GAMES; i += 1) store.createGameFromChess(new Chess());

  expectChessError("GAME_LIMIT_REACHED", () => store.createGame());
  assert.equal(store.gameCount(), MAX_GAMES);
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
  assert.equal(store.getSnapshot(first).revision, 0);

  now = 109;
  assert.equal(store.getSnapshot(first).revision, 0);
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

test("GameStore owns chess state and returns isolated snapshots", () => {
  const store = new GameStore({ createId: () => "game" });
  const source = new Chess();
  source.setHeader("Event", "snapshot test");
  source.setComment("start");
  source.move("e4");
  source.setComment("king pawn");
  const id = store.createGameFromChess(source);
  source.move("e5");

  const first = store.getSnapshot(id);
  assert.deepEqual(first.chess.history(), ["e4"]);
  assert.deepEqual(
    first.chess.getComments().map(({ comment }) => comment),
    ["start", "king pawn"],
  );
  first.chess.move("c5");

  const second = store.getSnapshot(id);
  assert.deepEqual(second.chess.history(), ["e4"]);
  assert.equal(second.chess.getHeaders().Event, "snapshot test");
  assert.deepEqual(
    second.chess.getComments().map(({ comment }) => comment),
    ["start", "king pawn"],
  );
  assert.equal(second.revision, 0);
});

test("GameStore applies parsed moves atomically at the expected revision", () => {
  const store = new GameStore({ createId: () => "game" });
  const id = store.createGame();
  const parsed = parseMove(store.getSnapshot(id).chess, "e4");

  const updated = store.applyMove(id, 0, parsed);
  assert.deepEqual(updated.chess.history(), ["e4"]);
  assert.equal(updated.revision, 1);
  expectChessError("STALE_POSITION", () => store.applyMove(id, 0, parsed));
  assert.deepEqual(store.getSnapshot(id).chess.history(), ["e4"]);
});
