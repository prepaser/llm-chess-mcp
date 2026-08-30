# Architecture

`llm-chess-mcp` is a stateful MCP server over stdio or Streamable HTTP. It owns
chess-game state and exposes deterministic tool contracts; Stockfish, Maia3,
and Lichess add independent signals without changing a game unless
`game_play_move` succeeds.

## Runtime boundary

`src/index.ts` is both the package and executable boundary. Importing it exposes
typed server APIs without loading `.env`; direct execution loads configuration,
parses transport options, and creates servers through `buildServer`. stdio is
the default; HTTP mode binds an explicit endpoint and creates one MCP server per
Streamable HTTP session. All sessions share application services and game state.
Stdout is reserved for protocol traffic; diagnostics belong on stderr. stdin
closure and process signals use idempotent shutdown that closes the active
transport and terminates Stockfish.

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
`AppServices` is the compatibility composite of narrower game, analysis,
candidate, explorer, and lifecycle capabilities; tool modules accept only the
capabilities they use.
Default `buildServer()` and `serveHttp()` handles share a reference-counted
service lease; closing the last handle terminates Stockfish. Injected services
remain caller-owned.

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

Core chess types and finite vocabularies live in `domain.ts`; tool schemas adapt
those types to MCP contracts rather than defining the domain model. `chess.ts`
remains the public chess facade while FEN-safe copying and PGN processing are
isolated in `chess-copy.ts` and `pgn.ts`. Candidate construction and intent
ranking are likewise separate policies.

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
4. Deleting a game removes it and frees process-wide game capacity. Closing an
   MCP HTTP session does not delete its games; expired and deleted IDs are no
   longer valid.

Custom positions are validated before snapshotting. King and pawn placement,
promotion material, castling rights, and en-passant metadata must describe a
consistent position, so cloning cannot synthesize pieces or expose impossible
moves. PGN setup headers are treated case-insensitively and canonicalized on
import so exported games remain re-importable. Header escapes are decoded and
re-encoded at the chess.js boundary, while every recursive annotation variation
is legality-checked from its parent position before only the mainline is stored.
An iterative pre-parser caps structural elements and strips variations before
the dependency parser runs, avoiding recursive dependency-stack growth. Header
count is capped separately and restoration uses one case-insensitive index.

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
a 2 MiB byte cap; after parsing, only 16 normal POST dispatches process-wide or
two per session may run concurrently. Initialization then reserves one of 64
session slots atomically.
A separately bounded control lane admits cancellation-only notifications when
those slots are saturated. The same normal limits independently bound downstream
compute and network jobs. A job retains its slot after the HTTP response or
socket closes and releases it only when the service promise settles. Sessions
with no active request expire after 30 minutes on a monotonic clock; expiry does
not delete their process-shared games. Open GET SSE streams keep their session
active without consuming POST permits. Header, upload, connection, socket, and
keep-alive limits are enforced by the Node listener. Partial uploads consume
connection and body limits but no POST dispatch permit. Deleting a session also
aborts any body reader that has not reached SDK dispatch.
`bodyTimeoutMs` bounds body upload only; engine and network work use their own
timeouts and MCP cancellation rather than a transport-wide request deadline.
Session reservations/expiry, POST admission, and downstream work admission are
independent state owners. The listener orchestrates them without duplicating
their counters or release rules.

The server has no MCP OAuth endpoints, OAuth discovery metadata, bearer-token
validation, or browser CORS support. A reverse proxy may implement its own
access policy, but its forwarded user or identity headers have no meaning to
this process. If browser access is introduced later, define the CORS policy at
the proxy explicitly; do not treat an `Origin` header as authentication.

## Compute and network services

Stockfish is a single worker-backed engine, so its service serializes analysis
requests through a bounded queue (32 active or waiting requests). It lazily
initializes the configured packaged flavor, performs the UCI/ready handshake,
and gives each request an analysis timeout plus a stop grace period. Init or
handshake failure, an engine command failure, or an analysis that does not stop
within its grace period invalidates and terminates the worker; a queued later
request initializes a fresh worker. Queue capacity fails fast, and shutdown
invalidates work from the old generation.

Request cancellation removes waiting analyses immediately. An active analysis
sends one UCI `stop` and keeps the queue fenced until `bestmove`; if the engine
does not stop within the grace period, the worker is terminated before queued
work reinitializes it. A timed-out request that receives `bestmove` during that
grace period is rejected, but its now-idle worker is reused. Partial lines from
a cancelled request are never returned. Shutdown drains the old queue, sends
UCI `quit`, retains a sink for late engine output, and fences the next engine
generation until teardown completes.
If shutdown begins while a worker-backed flavor is still loading, teardown
waits for the dependency callback before sending UCI `quit` and terminating the
worker. Terminal depth-zero score records without an explicit MultiPV rank are
reported as rank one rather than discarded.

Maia runs in a fixed pool of dedicated child processes with the bundled ONNX
model (5M by default). Child inference sessions are loaded lazily and reused
after successful creation. At most two inferences run concurrently, with 32
more waiting in a bounded queue; cancellation removes queued work immediately.
For each snapshot it
tokenizes position history, supplies both Elo inputs, masks logits to legal
moves, mirrors black-to-move moves for the model vocabulary, and normalizes the
remaining logits. The output is human move likelihood, never an evaluation.
ONNX Runtime has no safe cooperative cancellation API. Active cancellation or
the 30-second deadline therefore kills that inference child and waits for its
exit before releasing capacity. Queued cancellation removes the request before
dispatch. Idle children are unreferenced, and application shutdown terminates
the pool before permitting lazy restart. Inference children do not inherit the
Lichess credential.

Lichess is optional and token-gated. The explorer validates speed/rating filters
locally and forbids filters for `masters`. Each request has a five-second
attempt timeout, at most two attempts, and a twelve-second overall budget.
Only timeouts, network failures, HTTP 429, and 5xx responses retry. `Retry-After`
is honored only when it fits the remaining budget. Requests are serialized
process-wide, and a 429 applies a shared cooldown; a missing `Retry-After`
defaults to one minute. Authentication errors, other 4xx responses, invalid
input, and malformed responses fail without retry. Successful payloads are
checked against the legal moves of the snapshot before they can affect a candidate result.
Caller cancellation is combined with each attempt timeout and also interrupts
retry backoff; it is never converted into an Explorer availability failure.
Request budgets and the shared limiter each use a stable monotonic clock, while
HTTP-date `Retry-After` parsing uses wall time and rejects calendar rollover.
Response bodies must be valid
UTF-8 JSON and are capped at 1 MiB, 256 moves, and 256 characters per move or
opening string.
Its limiter, HTTP transport, response normalization, and retry policy are
separate internal modules, but response consumption remains inside the limiter
slot. Cancellation closes and awaits an in-flight response body before the next
serialized request starts.

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
