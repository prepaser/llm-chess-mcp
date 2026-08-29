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

test("GameStore default TTL timing is independent of wall-clock jumps", (t) => {
  let wallTime = 1_700_000_000_000;
  t.mock.method(Date, "now", () => wallTime);
  const store = new GameStore({
    idleTtlMs: 60_000,
    createId: () => "game",
  });
  const id = store.createGame();

  assert.equal(store.cleanupGames(Date.now()), 0);
  assert.equal(store.cleanupGames(wallTime + 1_000), 0);
  wallTime += 60 * 60 * 1_000;
  assert.equal(store.getSnapshot(id).revision, 0);
  wallTime = 0;
  assert.equal(store.getSnapshot(id).revision, 0);
});

test("explicit cleanup times do not advance the store clock", () => {
  let now = 100;
  const store = new GameStore({
    clock: () => now,
    idleTtlMs: 1_000,
    createId: () => "game",
  });
  const id = store.createGame();

  assert.equal(store.cleanupGames(500), 0);
  now = 101;
  assert.equal(store.getSnapshot(id).revision, 0);
  assert.equal(store.cleanupGames(100), 0);
  for (const invalid of [Number.NaN, Infinity, Number.MAX_VALUE]) {
    assert.throws(() => store.cleanupGames(invalid), RangeError);
  }
  assert.equal(store.getSnapshot(id).revision, 0);
});

test("default stores repeatedly accept current Date.now cleanup cutoffs", () => {
  for (let index = 0; index < 32; index += 1) {
    const store = new GameStore({ createId: () => `game-${index}` });
    const id = store.createGame();
    assert.equal(store.cleanupGames(Date.now()), 0);
    assert.equal(store.getSnapshot(id).revision, 0);
  }
});

test("GameStore rejects invalid or backward clock values without mutating games", () => {
  for (const value of [
    Number.NaN,
    Infinity,
    -Infinity,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
  ]) {
    const store = new GameStore({ clock: () => value });
    assert.throws(() => store.createGame(), RangeError);
  }

  let now = 100.5;
  const store = new GameStore({ clock: () => now, idleTtlMs: 10 });
  const id = store.createGame();
  now = 99.5;
  assert.throws(() => store.getSnapshot(id), RangeError);

  now = 100.5;
  assert.equal(store.getSnapshot(id).revision, 0);
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

test("GameStore rejects invalid generated IDs without consuming capacity", () => {
  for (const id of [42, null, {}, "", "x".repeat(257)]) {
    const store = new GameStore({
      maxGames: 1,
      clock: () => 0,
      createId: () => id as never,
    });
    expectChessError("GAME_ID_GENERATION_FAILED", () => store.createGame());
    assert.equal(store.gameCount(), 0);
  }

  let nextId: unknown = "valid";
  let calls = 0;
  const store = new GameStore({
    maxGames: 2,
    clock: () => 0,
    createId: () => {
      calls += 1;
      return nextId as string;
    },
  });
  const valid = store.createGame();
  nextId = null;
  expectChessError("GAME_ID_GENERATION_FAILED", () => store.createGame());
  assert.deepEqual(store.listGames(), [valid]);

  nextId = "second";
  assert.equal(store.createGame(), "second");
  nextId = "unused";
  expectChessError("GAME_LIMIT_REACHED", () => store.createGame());
  assert.equal(calls, 3);
});

test("GameStore rejects unsafe FEN counters before creating a game", () => {
  const store = new GameStore({ createId: () => "game" });
  const base = "8/8/8/8/8/8/K7/7k w - -";

  expectChessError("INVALID_FEN", () => store.createGame(`${base} 1e2 1`));
  expectChessError("INVALID_FEN", () =>
    store.createGame(`${base} 0 9007199254740992`),
  );
  assert.equal(store.gameCount(), 0);
});

test("GameStore normalizes only FEN parse failures", () => {
  const invalidFen = new GameStore({
    clock: () => 0,
    createId: () => "game",
  });
  expectChessError("INVALID_FEN", () => invalidFen.createGame("not a FEN"));

  const invalidClock = new GameStore({
    clock: () => Number.NaN,
    createId: () => "game",
  });
  assert.throws(() => invalidClock.createGame(), RangeError);
});

test("GameStore rejects positions where the inactive king is capturable", () => {
  const store = new GameStore({ createId: () => "game" });

  expectChessError("INVALID_FEN", () =>
    store.createGame("8/8/8/8/8/8/4k3/R3K3 w - - 0 1"),
  );
  assert.equal(store.gameCount(), 0);
});

test("GameStore rejects invalid castling and en passant state before snapshotting", () => {
  const store = new GameStore({ createId: () => "game" });
  for (const fen of [
    "4k3/8/8/8/8/8/P7/4K3 w KQkq - 0 1",
    "4k3/8/8/3P4/8/8/P7/4K3 w - e6 0 1",
  ]) {
    expectChessError("INVALID_FEN", () => store.createGame(fen));
  }
  assert.equal(store.gameCount(), 0);
});

test("GameStore owns chess state and returns isolated snapshots", () => {
  const store = new GameStore({ createId: () => "game" });
  const source = new Chess("7k/P7/8/8/8/8/8/K7 w - - 0 1");
  source.setHeader("Event", "snapshot test");
  source.setComment("start");
  source.move("a8=Q+");
  source.setComment("promotion");
  const headers = source.getHeaders();
  const id = store.createGameFromChess(source);
  source.move("Kh7");

  const first = store.getSnapshot(id);
  assert.deepEqual(first.chess.history(), ["a8=Q+"]);
  assert.deepEqual(first.chess.getHeaders(), headers);
  assert.deepEqual(
    first.chess.getComments().map(({ comment }) => comment),
    ["start", "promotion"],
  );
  first.chess.move("Kh7");

  const second = store.getSnapshot(id);
  assert.deepEqual(second.chess.history(), ["a8=Q+"]);
  assert.deepEqual(second.chess.getHeaders(), headers);
  assert.deepEqual(
    second.chess.getComments().map(({ comment }) => comment),
    ["start", "promotion"],
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
  updated.chess.move("e5");
  expectChessError("STALE_POSITION", () => store.applyMove(id, 0, parsed));
  assert.deepEqual(store.getSnapshot(id).chess.history(), ["e4"]);
});

test("GameStore rolls back a move that exceeds safe FEN counters", () => {
  const store = new GameStore({ createId: () => "game" });
  const id = store.createGame(
    "8/8/8/8/8/8/K7/7k b - - 0 9007199254740991",
  );
  const snapshot = store.getSnapshot(id);
  const move = parseMove(snapshot.chess, "Kh2");

  expectChessError("INVALID_FEN", () => store.applyMove(id, 0, move));
  const unchanged = store.getSnapshot(id);
  assert.equal(unchanged.revision, 0);
  assert.deepEqual(unchanged.chess.history(), []);
  assert.equal(unchanged.chess.fen(), snapshot.chess.fen());
});

test("GameStore preserves repetition history while applying moves", () => {
  const store = new GameStore({ createId: () => "game" });
  const id = store.createGame();

  for (const san of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]) {
    const snapshot = store.getSnapshot(id);
    store.applyMove(id, snapshot.revision, parseMove(snapshot.chess, san));
  }

  assert.equal(store.getSnapshot(id).chess.isThreefoldRepetition(), true);
});
