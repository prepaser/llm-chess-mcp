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

The HTTP listener is a backend, not a public edge. For non-local deployment it
must bind to localhost or a private network reachable only by a reverse proxy.
That proxy owns TLS, client authentication, external request/connection limits,
and any CORS policy; the Node process must not be exposed directly. The proxy
must preserve the public `Host` value and the process must list that hostname
with `--allowed-host`, so the existing Host and Origin validation continues to
apply after proxying.

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
| `game` | game creation/deletion, state, legal moves, PGN, and the only game mutation |
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
   process-wide 1,000-game limit is reached.
3. `game_play_move` compares `expected_revision` with the current revision,
   makes a legal move only on equality, then increments the revision.
4. Deleting a game removes the game. Closing an MCP HTTP session does not
   delete its games; expired and deleted IDs are no longer valid.

Games are process-shared. There is no per-user, per-client, or per-MCP-session
ownership record: possession of an opaque `game_id` is the capability required
to read, analyze, mutate, export, or delete that game. It is not an identity
token and must not be shared outside the trusted deployment. Reverse-proxy
authentication controls who can reach the service, but forwarded identity
headers are deliberately not trusted by the application and cannot create game
ownership.

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

## HTTP delivery semantics

MCP sessions are transport state only. They are not authentication credentials,
are held in memory, and are not a persistence or ownership boundary. The
application provides no event-replay guarantee: clients must not rely on SSE
replay, a disconnected session, a proxy retry, or a process restart to recover
an event stream. Re-read authoritative game state after reconnecting.

MCP cancellation notifications, session deletion, and server shutdown abort
the request signal passed into tools and services. A raw request disconnect is
not transaction cancellation: work may continue after a client or proxy stops
waiting. `expected_revision` makes a repeated move fail stale rather than apply
to a newer position, so clients that lose a response should read game state
before deciding what to do. Proxy timeouts are client-delivery limits, not proof
that backend work was cancelled.

HTTP admission is bounded before SDK dispatch. POST bodies are parsed once with
a 2 MiB byte cap, initialization reserves one of 64 session slots atomically,
and only 16 POSTs process-wide or two per session may run concurrently. The same
limits independently bound downstream compute and network jobs. A job retains
its slot after the HTTP response or socket closes and releases it only when the
service promise settles. Idle sessions expire after 30 minutes without deleting
their process-shared games. GET SSE streams do not consume POST permits and are
closed when their session expires. Header, upload, connection, socket, and
keep-alive limits are enforced by the Node listener.

The server has no MCP OAuth endpoints, OAuth discovery metadata, bearer-token
validation, or browser CORS support. A reverse proxy may implement its own
access policy, but its forwarded user or identity headers have no meaning to
this process. If browser access is introduced later, define the CORS policy at
the proxy explicitly; do not treat an `Origin` header as authentication.

## Compute and network services

Stockfish is a single worker-backed engine, so its service serializes analysis
requests through a bounded queue (32 active or waiting requests). It lazily
initializes the configured packaged flavor, performs the UCI/ready handshake,
and gives each request an analysis timeout plus a stop grace period. Init,
handshake, or analysis failure invalidates and terminates the worker; a queued
later request initializes a fresh worker. Queue capacity fails fast, and
shutdown invalidates work from the old generation.

Request cancellation removes waiting analyses immediately. An active analysis
sends one UCI `stop` and keeps the queue fenced until `bestmove`; if the engine
does not stop within the grace period, the worker is terminated before queued
work reinitializes it. Partial lines from a cancelled request are never returned.

Maia runs in-process with the bundled ONNX model (5M by default). Its inference
session is lazy and shared after successful creation. For each snapshot it
tokenizes position history, supplies both Elo inputs, masks logits to legal
moves, mirrors black-to-move moves for the model vocabulary, and normalizes the
remaining logits. The output is human move likelihood, never an evaluation.
ONNX Runtime has no request cancellation API, so cancellation is checked before
and after native inference and a completed cancelled result is discarded
without releasing the shared session.

Lichess is optional and token-gated. The explorer validates speed/rating filters
locally and forbids filters for `masters`. Each request has a five-second
attempt timeout, at most two attempts, and a twelve-second overall budget.
Only timeouts, network failures, HTTP 429, and 5xx responses retry. `Retry-After`
is honored only when it fits the remaining budget and does not exceed two
seconds; authentication errors, other 4xx responses, invalid input, and
malformed responses fail without retry. Successful payloads are checked against
the legal moves of the snapshot before they can affect a candidate result.
Caller cancellation is combined with each attempt timeout and also interrupts
retry backoff; it is never converted into an Explorer availability failure.

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
