# Architecture

`llm-chess-mcp` is a stateful MCP server over stdio or Streamable HTTP. It owns
chess-game state and exposes deterministic tool contracts; Stockfish, Maia3,
and Lichess add independent signals without changing a game unless
`game_play_move` succeeds.

## Runtime boundary

`src/index.ts` is the executable boundary. It loads environment configuration,
parses transport options, and creates servers through `buildServer`. stdio is
the default; HTTP mode binds an explicit endpoint and creates one MCP server per
Streamable HTTP session. All sessions share application services and game state.
Stdout is reserved for protocol traffic; diagnostics belong on stderr. Shutdown
closes active transports before terminating Stockfish.

The server is assembled from injected `AppServices`, not from tool-level global
lookups. Production constructs one service set for the process; tests pass
small fakes or controlled implementations. This keeps transport registration
separate from engine startup, network I/O, time, and storage.

```text
stdio --------> entrypoint -> buildServer(AppServices) -> tool modules
Streamable HTTP --^                                   |-> GameStore
                                                      |-> Stockfish service
                                                      |-> Maia service
                                                      `-> Lichess explorer
```

The tool modules have narrow ownership:

| Module | Owns |
|---|---|
| `game` | session creation/deletion, state, legal moves, PGN, and the only game mutation |
| `analysis` | Stockfish analysis, Maia distributions, and per-move evaluation |
| `candidates` | joins objective, human, and opening facets; intent ranking |
| `explorer` | Lichess input validation, requests, retry policy, and response validation |

Tool modules validate inputs, take a game snapshot where needed, call services,
and adapt data to output schemas. They do not reach into another module's
storage or manage an engine session directly.

## App services and game lifecycle

`AppServices` carries the application dependencies: a `GameStore`, Stockfish,
Maia inference, candidate computation, and the Lichess explorer. Dependencies
are interfaces at this boundary so tests can inject controlled services without
patching process globals. Clock and ID generation are injected into `GameStore`;
fetch, timeout, and sleep are injected at the explorer boundary.

`GameStore` owns `Chess` instances and their metadata:

1. Creating a game assigns an opaque ID and revision `0`; importing a PGN also
   creates a new game at revision `0`.
2. Reads refresh `lastAccessedAt`. Idle games expire after one hour, cleanup
   runs before store operations, and the store rejects creation once its
   1,000-session limit is reached.
3. `game_play_move` compares `expected_revision` with the current revision,
   makes a legal move only on equality, then increments the revision.
4. Deleting a game removes its session. Expired and deleted IDs are no longer
   valid.

All asynchronous readers clone the position first. The snapshot is rebuilt
from the initial position and move history, preserving history-dependent chess
rules such as threefold repetition. A long analysis therefore observes one FEN
and one revision even if a later request changes the live game.

```text
read game -> snapshot + revision R -> async analysis -> result tagged R
                                                   \
play(expected_revision: R) -> mutate live game -> revision R + 1
```

An analysis result is informational, not a lock. A caller must use the revision
it read when submitting `game_play_move`; a stale write returns
`STALE_POSITION` rather than applying a move to a different position.

## Compute and network services

Stockfish is a single worker-backed engine, so its service serializes analysis
requests through a bounded queue (32 active or waiting requests). It lazily
initializes the configured packaged flavor, performs the UCI/ready handshake,
and gives each request an analysis timeout plus a stop grace period. Init,
handshake, or analysis failure invalidates and terminates the worker; a queued
later request initializes a fresh worker. Queue capacity fails fast, and
shutdown invalidates work from the old generation.

Maia runs in-process with the bundled ONNX model (5M by default). Its inference
session is lazy and shared after successful creation. For each snapshot it
tokenizes position history, supplies both Elo inputs, masks logits to legal
moves, mirrors black-to-move moves for the model vocabulary, and normalizes the
remaining logits. The output is human move likelihood, never an evaluation.

Lichess is optional and token-gated. The explorer validates speed/rating filters
locally and forbids filters for `masters`. Each request has a five-second
attempt timeout, at most two attempts, and a twelve-second overall budget.
Only timeouts, network failures, HTTP 429, and 5xx responses retry. `Retry-After`
is honored only when it fits the remaining budget and does not exceed two
seconds; authentication errors, other 4xx responses, invalid input, and
malformed responses fail without retry. Successful payloads are checked against
the legal moves of the snapshot before they can affect a candidate result.

## Result and contract rules

Every registered tool declares an MCP output schema. On success its payload is
the canonical `structuredContent`; `content` is one short display summary and
is deliberately not a JSON data channel. Handler failures set `isError: true`
and return `{ error: { code, message } }` in `structuredContent`. SDK
input-schema failures happen before the handler and retain the SDK's standard
text-only error result.

Contract snapshots capture the externally visible tool list, descriptions,
annotations, and input/output schemas. Update them only as part of an
intentional contract change:

1. Change the relevant input/output schema and tool adapter together.
2. Update focused unit and stdio tests, then run `pnpm contract:update` to
   regenerate the snapshot.
3. Review the snapshot diff as an API diff: names, required fields, enum values,
   nullability, and error codes are compatibility surface.
4. Run `pnpm contract:check` and the full local gate before merging.

Do not regenerate a snapshot merely to make a failing check pass. If a change
is not intended to alter the public MCP contract, its snapshot must remain
unchanged.
