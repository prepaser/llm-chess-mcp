# llm-chess-mcp

An MCP chess runtime that lets LLMs play, analyze, and adapt their strength
without outsourcing every decision to an engine.

Rather than returning a single best move, it exposes objective strength
(Stockfish and Lc0), human move likelihood (Maia3), and real-game statistics (Lichess)
so the LLM can choose how it wants to play. The LLM does the strategy and
judgment; the MCP server handles all the computation.

## Engines

| Engine | Role | Runtime |
|---|---|---|
| **Stockfish 18** (WASM) | Objective evaluation, best moves, multipv | In-process (npm `stockfish`) |
| **Lc0** (native) | Independent neural-network search and candidate ranking | Bundled child process, CPU by default |
| **Maia3 5M** (ONNX) | Human-like move probabilities conditioned on Elo | Dedicated Node child processes (`onnxruntime-node`) |
| **Lichess explorer** | Real human game statistics | HTTP (needs token) |

No separately installed engine executable or Python runtime is required for the
bundled CPU engines on supported platforms. Stockfish runs in the server process;
Lc0 and Maia inference run in dedicated child processes. Lc0 CPU bundles target
Linux x64 (glibc >= 2.35) and Windows x64. The published package bundles the Maia3 5M model; other
export variants are not runtime options unless their ONNX files are provided
separately.

### Analysis modes

Analysis defaults to `both`. Set `ENGINE_MODE=stockfish` or `ENGINE_MODE=lc0`
for a server-wide default, or pass `engine_mode` to analysis, move evaluation,
and candidate tools. A request overrides the environment, which overrides the
packaged default. Single-engine requests never initialize or check the other
engine and never silently switch engines on failure.

Results identify each engine as `ok`, `error`, or `not_requested`.
When one engine fails in `both` mode, the successful result is returned with
`partial: true`. Both failing is an error. Cancellation stops the whole request.
Scores, WDL, principal variations, and move classifications remain engine-local;
centipawn values from different engines are never averaged. Move classification
uses the existing CP-loss heuristic within each engine, not a calibrated
cross-engine measure of move quality.

Candidate consensus uses equal-weight reciprocal rank fusion:
`sum(1 / (60 + rank)) / successfulEngineCount`. An unranked move contributes
zero without being labeled bad. Within each engine, tied intent scores retain
the engine's original ranking. Consensus ties prefer more supporting engines, then UCI
order. This is a ranking score, not a probability. `natural` remains Maia-only;
`ease_off` and `give_chance` require every successful engine to approve the
candidate using available WDL data.

Stockfish retains depth-based limits. Lc0 uses `movetime_ms`, with default
`fast`/`normal`/`deep` budgets of 1000/3000/10000 ms. Reported depths and node
counts are not comparable between engines. Full game history is passed when
available; FEN-only games have no inferred real history.

## Build from source

The published runtime supports Node.js 20.3 and newer. Repository maintenance
uses Node.js 22.13 or newer because pnpm 11 and the coverage gate require it.

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm test:unit` runs the unit suite. `pnpm test:e2e` builds first, then runs
the MCP transport tests. `pnpm check` runs the full local gate; use
`pnpm release:check` before publishing.

## Transports

stdio remains the default transport and requires no flags. To expose a local
Streamable HTTP endpoint instead:

```bash
pnpm build
node dist/index.js --transport http
```

The server listens on `http://127.0.0.1:3000/mcp` and supports Streamable HTTP
sessions, JSON responses, and SSE. The equivalent development command is
`pnpm dev:http`.

To accept external connections, bind to all IPv4 interfaces:

```bash
node dist/index.js --http --host 0.0.0.0 --port 3000
```

Use `--host ::` for IPv6. MCP requests are not restricted by hostname.
Authentication and TLS can be configured independently.

HTTP options:

```text
--host <host>            Bind host (default: 127.0.0.1)
--port <port>            Listen port (default: 3000)
--path <path>            Endpoint path (default: /mcp)
```

The package also exposes a typed ESM API:

```js
import { serveHttp } from "llm-chess-mcp";

const server = await serveHttp({ port: 3000, bodyTimeoutMs: 15_000 });
await server.close();
```

Pass `signal: abortController.signal` to cancel pending startup, including initial
ACME issuance. Once startup resolves, use `server.close()` to stop the server.

TLS file paths are resolved when `serveHttp()` is called, so later working-directory
changes do not redirect certificate storage. Rate-limit and TLS settings are
copied at startup; modifying the original option objects does not reconfigure
a running server.

The root API also exports `buildServer`, `GameStore`, `ChessError`,
`ExplorerError`, the service/domain types needed to provide custom
`AppServices`, and safe chess helpers including `parseImportedPgn`, `pgnOf`,
and `snapshotChess`. The package root is the supported public API. Deep imports
under `dist/` are intentionally not exported and will fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED`; use named root exports instead.

`bodyTimeoutMs` limits HTTP body upload time; it is not a whole-tool deadline.
The deprecated `requestTimeoutMs` alias remains supported when `bodyTimeoutMs`
is omitted.

Authentication and TLS are optional. Without Bearer configuration, HTTP is
anonymous and sessions share games: anyone who knows a game ID can access it.
With authentication enabled, each Bearer is a separate identity; sessions using
the same Bearer share games, while other Bearers and anonymous clients cannot
access them. Games remain in memory and expire after an hour of inactivity.

For personal use, set `HTTP_BEARER` in the environment or `.env`. For multiple
Bearers, use `--bearer-file /path/to/bearers.txt` with one raw Bearer per UTF-8
line (blank lines are ignored). These sources are mutually exclusive, and an
explicitly empty source fails startup. Files are read only at startup; restart
to add or revoke a Bearer. Generate secrets with `openssl rand -hex 32`, protect
the file, and never put it in version control. Each key is one identity, not an
alias for another key. API callers supply `auth: { bearer }` or
`auth: { bearerFile }`; `serveHttp()` does not implicitly read environment secrets.
Custom `AppServices.games` must implement `forScope(scope)` when authentication
is enabled; the built-in `GameStore` already provides this ownership boundary.
Repositories without that capability remain supported for anonymous HTTP and
stdio, but authenticated startup rejects them instead of silently sharing games.
HTTP and stdio tools receive scoped views even when they share one backing store.
The raw `GameStore` API remains administrative and can access all scopes; do not
expose it directly to untrusted clients. `createScopedGameRepository()` selects
a scope without exposing its factory to the tool layer.

Clients send `Authorization: Bearer <key>` on every MCP request, including SSE
and DELETE. This is static Bearer authentication, not OAuth discovery. Use HTTPS
or a trusted TLS-terminating proxy to avoid sending keys in plaintext.

### HTTPS

Use existing PEM files with manual TLS (restart after replacing them):

```bash
node dist/index.js --http --host 0.0.0.0 \
  --bearer-file /etc/llm-chess/bearers.txt \
  --tls-cert /etc/llm-chess/fullchain.pem --tls-key /etc/llm-chess/key.pem
```

For built-in Let's Encrypt HTTP-01 issuance and renewal:

```bash
node dist/index.js --http --host 0.0.0.0 \
  --bearer-file /etc/llm-chess/bearers.txt \
  --acme-domain chess.example.com --acme-email admin@example.com \
  --acme-agree-tos --acme-storage /var/lib/llm-chess/acme
```

TLS defaults to port 443 unless `--port` is explicit. The domain must resolve to
this server and external port 80 must reach the challenge listener. You may map
port 80 to a different local `--acme-challenge-port`; wildcard certificates and
DNS-01 are not supported. Use port forwarding or a service-manager configuration
to bind privileged ports without running the entire application as root.
The challenge listener uses the application's bind host by default. Use
`--host ::` for IPv6 (and IPv4 too where the OS supports dual-stack binding), or
override only the challenge address with `--acme-challenge-host <host>`.
Every published A/AAAA address must route external port 80 to that listener.
HTTPS and the challenge listener must use different fixed local ports; conflicting
settings fail before issuance. For example, a loopback-only application behind a
proxy can use `--host 127.0.0.1 --acme-challenge-host ::` for a public challenge
listener while keeping the application on loopback.

The challenge listener serves only active HTTP-01 challenges, never MCP or a
plaintext-to-HTTPS redirect. Existing valid certificates are reused; otherwise
startup waits for issuance. Certificates are renewed automatically and replaced
without restarting the HTTPS server. Renewal failures are retried; if a
certificate expires, connections are closed and MCP is unavailable until a
valid certificate is installed. There is no plaintext fallback.

Keep the ACME storage directory private and persistent. A lock prevents two
controllers from sharing it; after an unclean process exit, verify that no
instance uses the directory before removing a stale lock. Back up the directory
securely. Use `--acme-staging` with a **separate storage directory** to test the
deployment without production issuance; staging certificates are not publicly
trusted. Specifying `--acme-agree-tos` explicitly accepts the provider's terms.
Manual TLS and ACME options cannot be combined.

Programmatic configuration uses `tls: { mode: "manual", certPath, keyPath }` or
`tls: { mode: "acme", domain, email, storageDir, termsOfServiceAgreed: true }`.
Both modes require TLS 1.2 or newer.

## Lichess token (optional)

To enable the opening explorer, generate a personal access token
at <https://lichess.org/account/oauth/token/create> and set it in `.env`:

```bash
cp .env.example .env
# set LICHESS_TOKEN=...
```

Without a token, `opening_explorer` returns a disabled notice; all other tools work.

Explorer filters are strict. Speeds are `ultraBullet`, `bullet`, `blitz`,
`rapid`, `classical`, and `correspondence`; rating buckets are `0`, `1000`,
`1200`, `1400`, `1600`, `1800`, `2000`, `2200`, and `2500`. `masters` accepts
neither filter. Invalid filters fail locally. Transient failures (network,
timeout, 429, and 5xx) are retried once within a 12-second total budget;
invalid requests and other 4xx responses are not retried. Responses must be
valid UTF-8 JSON and are limited to 1 MiB, 256 moves, and 256 characters per
move or opening string.

## Configure in your MCP client

### opencode

Add to `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "llm-chess-mcp": {
      "type": "local",
      "command": ["npx", "-y", "llm-chess-mcp"],
      "enabled": true,
      "environment": {
        "LICHESS_TOKEN": "your-token"
      }
    }
  }
}
```

### Claude Code

Add to `.mcp.json` (project) or `~/.claude.json` (global), or run:

```bash
claude mcp add llm-chess-mcp -- npx -y llm-chess-mcp
```

```json
{
  "mcpServers": {
    "llm-chess-mcp": {
      "command": "npx",
      "args": ["-y", "llm-chess-mcp"],
      "env": {
        "LICHESS_TOKEN": "your-token"
      }
    }
  }
}
```

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.llm-chess-mcp]
command = "npx"
args = ["-y", "llm-chess-mcp"]

[mcp_servers.llm-chess-mcp.env]
LICHESS_TOKEN = "your-token"
```

Or via the CLI:

```bash
codex mcp add llm-chess-mcp --env LICHESS_TOKEN=your-token -- npx -y llm-chess-mcp
```

## Tools

| Tool | Description |
|---|---|
| `create_game` | Create a game (optionally from a FEN), returns `game_id` |
| `delete_game` | Delete a game in the current scope and free game capacity |
| `game_state` | Authoritative state: FEN, turn, revision, check/mate/draw flags, history, last move, castling (optional ASCII) |
| `game_play_move` | Play a move (SAN or UCI) with a stale-position guard |
| `game_legal_moves` | All legal moves with metadata |
| `game_pgn` | Export the game as PGN |
| `game_import_pgn` | Import a PGN into a new game |
| `position_analyze` | Per-engine MultiPV lines (cp/mate/WDL + UCI/SAN PV), consensus ranking, and `analysis_level` preset |
| `human_move_distribution` | Maia3 human-move probabilities at a target Elo |
| `move_evaluate` | Score one or more moves + cpLoss + classification |
| `move_candidates` | **Primary tool**: unified candidates (objective + human + opening) |
| `move_candidates_by_intent` | Convenience layer: candidates ranked for a strategic intent |
| `opening_explorer` | Lichess human game statistics |

## Result format

`structuredContent` is the canonical successful result. Handler-level failures
set `isError` and provide `structuredContent.error`. Input-schema failures are
generated by the MCP SDK before the handler and use its standard `isError` text
result without `structuredContent`. Otherwise, `content` is only a short
human-readable summary and must not be parsed as data.

## Score conventions

- Engine analysis scores are **side-to-move perspective**: positive cp = side to move is
  better; `mate N` = side to move mates in N. `wdl` is `[win, draw, loss]` in
  permille for the side to move.
- `move_candidates` gives per-engine `objective.byEngine` values with `moverCp` (the mover's perspective — higher is better
  for the player choosing the move) and `whiteCp` (fixed white perspective) so
  the sign never flips on you.
- `move_evaluate` reports the score **from the mover's perspective**, plus `cpLoss`
  (centipawns lost vs the best move) and a classification:
  `best / excellent / good / inaccuracy / mistake / blunder`.
- `maia3Prob` is a **human-likelihood**, not move quality. A high-probability move
  can still be objectively bad.
- Successful analysis continuations return corresponding `pv` and `pvSan`
  arrays of equal length in UCI and SAN. An invalid engine continuation is
  rejected at the internal tool boundary instead of returning a truncated
  `pvSan`.

## Candidate structure

`move_candidates` returns each candidate with three independent facets:

```json
{
  "uci": "g1f3",
  "san": "Nf3",
  "objective": {
    "byEngine": {
      "stockfish": { "rank": 1, "moverCp": 55, "whiteCp": 55, "cpLoss": 0, "moverMate": null, "whiteMate": null, "wdl": [153, 844, 3] },
      "lc0": { "rank": 1, "moverCp": 45, "whiteCp": 45, "cpLoss": 0, "moverMate": null, "whiteMate": null, "wdl": [200, 750, 50] }
    }
  },
  "consensusRank": 1,
  "consensusScore": 0.01639344262295082,
  "support": 2,
  "human": { "maia3Prob": 0.62, "selfElo": 1500, "opponentElo": 1500 },
  "opening": { "status": "available", "games": 18421, "frequency": 0.31, "white": 9000, "draws": 3000, "black": 6421, "averageRating": 1800 }
}
```

- `objective.byEngine` — independent Stockfish and Lc0 evaluations; an engine's
  entry is `null` when it did not evaluate that candidate.
  `moverCp` is from the mover's perspective (higher = better for the chooser).
- `human` — Maia3 conditional probability at a target Elo.
- `opening` — Lichess empirical frequency (a different signal from Maia3).

`opening.status` is `available`, `no_data` (API ok but no games in this
position), `unavailable` (the explorer request failed), or `disabled` (no token).
Explorer failure does not discard successful engine or Maia3 results. The
selected engine mode controls which engines run. In `both` mode, one engine
failure yields `partial: true`; both failing produces a tool error. Top-level
`engines` records each outcome and `enginesUsed` lists successful engines.

`move_candidates` also returns `moveSensitivity`, describing how sharply the
evaluation changes across the top engine lines:

```json
{
  "moveSensitivity": {
    "stockfish": { "level": "high", "topMoveSpreadCp": 245 },
    "lc0": { "level": "medium", "topMoveSpreadCp": 120 }
  }
}
```

`level` is `low` (<80cp spread), `medium` (80–200cp), or `high` (≥200cp). High
sensitivity means choosing among plausible alternatives can materially change
the evaluation — useful for deciding whether to ease off or play precisely.
An unavailable or unrequested engine has `null` sensitivity. The two engines'
centipawn scales are independent and should not be compared directly.

## Analysis levels

Position and candidate tools accept an `analysis_level` preset:

| Level | Stockfish depth | MultiPV | Lc0 time (ms) |
|---|---|---|---|
| `fast` | 8 | 5 | 1000 |
| `normal` | 15 | 8 | 3000 |
| `deep` | 22 | 10 | 10000 |

Position analysis accepts `depth`/`multipv` overrides; candidate tools use
`sf_depth`/`sf_multipv`. `movetime_ms` overrides the Lc0 budget in either tool.
`move_evaluate` defaults to depth 15 and 3000 ms and accepts explicit overrides.

## Stale-position guard

Every state read returns a `revision`. `game_play_move` **requires**
`expected_revision`; if the game has advanced since your last read, the move is
rejected:

```json
{ "error": { "code": "STALE_POSITION", "message": "position changed: expected revision 2, current 3" } }
```

## Runtime limits

- Up to 1,000 games are retained per process; idle games expire after one hour.
- `move_evaluate` accepts at most 10 moves per call.
- Imported and exported PGNs are limited to 1 MiB, 256 headers, and 4,096
  plies; stored snapshots enforce the same byte, header, token, and ply resource
  bounds. Imports also cap the mainline and variations together at 32,768
  structural elements and 16 KiB per lexical token. Every variation is
  legality-checked; game state retains the mainline. UTF-8 BOMs and standard
  escaped header values are supported.
- Custom FENs reject inconsistent castling/en-passant metadata and impossible
  pawn or promotion material.
- Stockfish and Lc0 each accept up to 32 active or queued analyses. Maia runs at most two
  inferences concurrently and queues up to 32 more.
- Lichess Explorer requests run one at a time and share 429 cooldowns.
- HTTP retains at most 64 MCP sessions; sessions with no active request expire
  after 30 minutes. An open GET/SSE stream keeps its session active.
- HTTP accepts bodies up to 2 MiB under normal body-parser capacity. Once those
  parsers are full, an overflow request receives only a small, up-to-8 KiB
  probe; only a complete MCP cancellation notification can proceed, and no
  accepted parser is preempted. The listener's connection limit bounds overflow
  probes. After body parsing, it permits 16 concurrent POST dispatches and
  downstream compute/network jobs process-wide, with two of each per session.
  A separate bounded control lane prioritizes MCP cancellation when normal
  dispatch capacity is full. If an existing-session POST response closes before
  it finishes, its session is closed and its work is aborted; an uncooperative
  downstream operation still holds capacity until it settles. HTTP also caps
  connections at 128 and applies a 15-second body upload deadline plus bounded
  header, socket, and keep-alive timeouts.

HTTP applies global and IP limits even without authentication; authenticated
requests additionally consume Bearer limits. Sessions or keys cannot bypass an
IP quota, and changing IP cannot bypass a Bearer quota. Counters are local to
one server runtime and reset on restart; they are not distributed quotas.

| Resource | Per IP | Per Bearer | Global |
| --- | --- | --- | --- |
| Requests/minute (burst) | 60 (10) | 60 (10) | 600 (100) |
| Session creations/minute (burst) | 6 (2) | 6 (2) | 60 (10) |
| Heavy tool calls/minute (burst) | 12 (2) | 12 (2) | 60 (10) |
| Open sessions | 4 | 4 | 64 |
| Concurrent operations | 2 | 2 | 16 |
| TCP connections | 8 | — | 128 |

Failed authentication has additional budgets of 10/minute (burst 5) per IP
and 120/minute (burst 20) globally.
The failure budgets apply only to invalid credentials; exhausted failure budgets
do not reject valid Bearers. Ordinary global/IP/Bearer request limits still apply.
Cancellation and deletion use a separate bounded control budget. Rate-limit
rejection returns `429` and `Retry-After`; tool-level throttling returns `RATE_LIMITED`
with `error.retry_after_seconds`. Existing upload and concurrency protections
still apply. Identity state is bounded; new identities are rejected when the
state table is full instead of evicting active quotas.

A tool call consumes one heavy token when its first heavy operation starts.
Multiple moves in `move_evaluate`, internal retries, and parallel work within that
call do not consume extra tokens. Each tool call in a JSON-RPC batch has its own
budget. Input validation failures and work rejected by concurrency limits before
starting consume no heavy tokens; started work is not refunded on failure or
cancellation. Actual service operations still acquire separate concurrency slots
and hold them until they settle, including uncooperative cancelled work. Larger
calls can cost more CPU time even though their token cost is the same; input
limits and engine concurrency safeguards remain in force.

By default the client IP is the socket peer. Repeat `--trusted-proxy <CIDR>` to
trust explicit reverse proxies: only their `X-Forwarded-For` chain is used,
walking from the nearest hop to the first untrusted address. Your proxy must
overwrite or correctly append this header. IPv4-mapped addresses are normalized
and IPv6 quotas use /64 prefixes. TCP quotas always apply to the actual peer;
adjust them when a trusted proxy aggregates many clients. Public-edge protection
is still useful against traffic that saturates the host or network itself.

Programmatic users can override limits through `HttpServerOptions`; use
`--help` for the corresponding CLI settings.

For example, tune IP request and work budgets independently:

```bash
node dist/index.js --http \
  --rate-limit-ip-request-per-minute 120 --rate-limit-ip-request-burst 20 \
  --rate-limit-ip-work-per-minute 6 --rate-limit-ip-work-burst 2 \
  --max-connections-per-ip 8 --max-sessions-per-ip 4 --max-work-per-ip 2
```

The equivalent API settings are
`rateLimits: { request: { ip: { ratePerMinute: 120, burst: 20 } }, work: { ip: { ratePerMinute: 6, burst: 2 } } }`.
Each `global`, `ip`, and `bearer` dimension is independently configurable. A zero
rate denies that operation; it does not disable its limiter. Shared NATs share
IP budgets, so adjust limits to your actual deployment.

MCP cancellation notifications, session deletion, and server shutdown propagate
to body uploads and Stockfish, Lc0, Maia, and Lichess work. Stockfish stops safely at
its UCI queue boundary, cancels queued work and drains active work during
shutdown, and rejects new analysis until teardown completes. Lc0 rejects active
and queued work on shutdown and waits for its process to exit, escalating
termination when necessary.
Lichess fetch and retry waits abort
immediately. Maia runs native inference in dedicated child processes; cancelling
active work terminates its child, while queued cancellation is immediate. A raw
response disconnect for an existing-session POST closes that session and aborts
its work. Reconnect with a new session using the same Bearer, if enabled, then
re-read the game state before retrying a move.

## Intents

`move_candidates_by_intent` ranks candidates for a chosen intent. It is a
convenience layer over `move_candidates`; the fixed thresholds below are
heuristic defaults, not the source of truth:

| Intent | Meaning |
|---|---|
| `best` | Strongest engine move |
| `strong` | Engine-strong but human-plausible |
| `natural` | Most human-typical at the target Elo |
| `balanced` | Blend of strength and human-likeness |
| `ease_off` | Human-plausible moves that modestly reduce advantage without changing the expected result |
| `give_chance` | Human-plausible inaccuracies that meaningfully improve the opponent's chances |

This tool ranks candidates but does not choose a move. Use the returned signals
and conversation context to make the final decision — do not map user skill
mechanically to an intent.

## Example flow

The normal play loop is three calls:

1. `create_game` → `game_id`
2. `move_candidates` → pick a move
3. `game_play_move` (with `expected_revision`) → commit it

Go deeper only when you need to:

- `position_analyze` — objective best lines
- `human_move_distribution` — what a human of a given Elo would play
- `opening_explorer` — real-game statistics
- `move_evaluate` — score a specific move (or compare several)

## Export Maia3 to ONNX

The publisher chooses the model in `model.config.json`. The export step needs
Python + PyTorch once; it downloads the pinned checkpoint, verifies the
reimplementation against the original, and writes the verified ONNX bundle to
`models/`.

```bash
uv venv .venv-maia3 --python 3.13
uv pip install --python .venv-maia3/bin/python -r scripts/requirements.txt
uv pip install --python .venv-maia3/bin/python "maia3 @ git+https://github.com/CSSLab/maia3.git@1e13597c42d4858b7cfd7cfdae01e297263364b2"
.venv-maia3/bin/python scripts/export_maia3.py --device cpu
```

The default `--config` is the repository's `model.config.json`; pass another
config path to export a different supported Maia3 variant. The generated
`models/manifest.json` records the source, checkpoint digest, model filename,
and artifact digests. Run `pnpm model:check` before packaging to verify that
the manifest still matches the config and files.

The default config selects the current pinned 5M checkpoint:

```json
{
  "schemaVersion": 3,
  "analysis": { "mode": "both" },
  "maia3": {
    "model": "5m",
    "source": {
      "type": "huggingface",
      "repoId": "UofTCSSLab/Maia3-5M",
      "filename": "maia3-5m.pt",
      "revision": "b6559de2398d7140b985f28fd2c19fb5e47ddabe"
    }
  },
  "stockfish": {
    "version": "18.0.8",
    "flavor": "lite-single"
  },
  "lc0": {
    "version": "0.32.1",
    "weights": {
      "url": "https://storage.lczero.org/files/networks-contrib/t1-256x10-distilled-swa-2432500.pb.gz",
      "sha256": "bc27a6cae8ad36f2b9a80a6ad9dabb0d6fda25b1e7f481a79bc359e14f563406"
    },
    "backend": "cpu",
    "platforms": ["linux-x64", "win32-x64"]
  }
}
```

Supported architectures are `3m`, `5m`, `23m`, and `79m`; the source checkpoint
must match the selected architecture. Hugging Face revisions must be full
lowercase commit SHAs. For local weights, replace `maia3.source` with
`{"type": "local", "path": "weights/checkpoint.pt"}`. Relative checkpoint
paths resolve against the config file, not the working directory.
Absolute local checkpoint paths are also accepted; prefer relative paths for
portable configs.
`--cache-dir` optionally controls the Hugging Face download cache.

Model/source selection uses the config file. Export always verifies before
replacing the bundle; there is no `--skip-verify` or custom `--out`.
`pnpm export:maia3` is equivalent
when the required Python environment is active.

The workflow is: edit the root config, export, run `pnpm check`, then run
`pnpm test:package`. Exporting with another config does not change the root
config; make them agree before packaging. Any unlisted files left over after
switching models must be removed or moved out of `models/` explicitly; checks
report them and never delete them automatically.

Normal `pnpm build` only compiles TypeScript. npm includes the generated
`models/` alongside `dist/`, not the Python scripts, source checkpoint, or build
config. Consumers do not download weights from Hugging Face at install or
runtime. With `MAIA3_MODEL` unset, the bundled manifest chooses the default;
an explicit supported key retains package-then-working-directory model lookup.

Exporter regression tests run separately from the Python-free Node checks:

```bash
.venv-maia3/bin/python -m unittest discover -s scripts -p 'test_model_*.py'
```

## Maia3 ONNX verification

The exported ONNX model is regression-tested against the upstream Maia3
implementation across fixed positions and Elo pairs:

```bash
.venv-maia3/bin/python scripts/verify_maia3.py --config model.config.json
```

Use `--onnx path/to/model.onnx` to verify a specific ONNX artifact. Without it,
verification reads the model filename from the generated manifest.

It checks top-1/top-k move agreement and max probability error to detect
export/runtime regressions. The bundled `maia3-5m.onnx` passes with 100% top-1
and top-5 agreement and max probability error < 1e-4.

## Configure Stockfish

The same `model.config.json` selects the exact npm `stockfish` version and
default engine flavor. `18.0.8` is the npm package version; it contains the
Stockfish 18 engine. Version ranges, tags, and prereleases are not accepted.
Supported flavors are `full`, `single`, `lite`, `lite-single`, `single-lite`
(an alias), and `asm`.

After editing the `stockfish` section:

```bash
pnpm stockfish:prepare
pnpm check
pnpm test:package
```

Preparation uses pnpm to pin and install the exact dependency and update the
lockfile, compiles TypeScript, then checks initialization, UCI readiness,
analysis, and shutdown using the configured flavor. Only after successful
verification is the default flavor recorded in `package.json`. An incompatible
version fails preparation; older loader APIs are not automatically adapted.
If preparation fails, dependency files may already have changed. Correct the
configuration or compatibility error and rerun it; Git changes are never
automatically reverted.

Runtime selection is an explicit engine option, then `STOCKFISH_FLAVOR`, then
the packaged default. The real loader rejects an installed package version
that differs from the pinned dependency. Consumers receive Stockfish as an
exact npm dependency; the running server never installs or switches versions.

`pnpm model:check` validates Maia, Stockfish, and Lc0 artifacts without
downloading or installing anything. Stockfish-only changes do not require Maia
export: its manifest continues to record only normalized Maia settings. Build
configs use the schema version shown above. Ordinary builds do not install
engines. External NNUE replacement and flavor-specific package
size optimization are not provided.

## Package verification

Lc0 engines and weights are prepared by the publisher with `pnpm lc0:prepare`.
Preparation runs on Linux with Docker and Wine available. The Linux CPU build
uses Ubuntu 22.04 and DNNL; the runtime backend is named `blas` even when DNNL
provides its matrix operations. If Docker requires sudo, explicitly set
`LC0_DOCKER_SUDO=1`. The Linux engine source archive and third-party notices are
retained with the prepared artifacts. A prebuilt Linux artifact directory may instead be
supplied through `LC0_LINUX_BUNDLE`.
The staged bundle is checked before it replaces a previous working bundle.
Preparation includes every platform selected in the config; partial-platform
replacement is rejected. If the root config changes during preparation, the
existing bundle is preserved and preparation must be rerun.
`bundle/lc0/manifest.json` records platform executables, required libraries,
backend, network identity, and SHA-256 digests. The package contains artifacts
for both supported platforms and a shared pinned weight file; it does not
download models or install GPU software when the server starts.

On Windows 10/11 x64, install the official
[Microsoft Visual C++ v14 x64 Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe)
before using Lc0. The Lc0/DNNL binaries require `MSVCP140.dll`, `VCOMP140.dll`,
`VCRUNTIME140.dll`, and `VCRUNTIME140_1.dll`; Microsoft runtime DLLs are not
redistributed in this package. Stockfish-only mode does not require Lc0 or
its native runtime prerequisites.

CPU is the default. CUDA is a build-time option requiring a compatible NVIDIA
environment and a successful preparation probe. A missing GPU/backend is an
explicit engine failure, not an implicit switch to CPU. Windows validation via
Wine is supplementary and must not be reported as a native Windows test.
CUDA preparation takes a matching Linux artifact directory in
`LC0_LINUX_BUNDLE` and a Windows archive in `LC0_WINDOWS_ARCHIVE`, with its
SHA-256 in `LC0_WINDOWS_ARCHIVE_SHA256`. It does not install GPU drivers.

Package artifacts are verified locally; this project intentionally has no
hosted CI workflow.

Run `pnpm check` for the deterministic offline gate. Use `pnpm test:package` to
pack the project, install the tarball in a clean temporary directory, and run
the installed `llm-chess-mcp` binary against the real Stockfish, Lc0, and Maia
runtimes. `pnpm release:check` runs both checks plus the production dependency
audit and package manifest dry run.

Package verification uses the OS temporary directory by default. If it exceeds
its disk quota or free space, select a larger writable location:

```bash
PACKAGE_SMOKE_TMPDIR=/path/on/larger/disk pnpm test:package
```

The same environment variable applies to `pnpm release:check` and publishing.
Temporary installs are removed after success or failure. On failure, a bounded
diagnostic report (including available npm log excerpts) is saved separately in
`.package-smoke-failures/`; `PACKAGE_SMOKE_LOGDIR` overrides that location.
Keep diagnostic logs private and review them before sharing. They are not
included in the npm package.

## License & attribution

This project is licensed under the **AGPL-3.0** (see `LICENSE`).

It bundles and depends on third-party components:

| Component | License | Source |
|---|---|---|
| [Maia3](https://github.com/CSSLab/maia3) (Chessformer) | AGPL-3.0 | UofT CSSLab — Monroe et al., *Chessformer: A Unified Architecture for Chess Modeling* (ICLR 2026) |
| [Stockfish](https://github.com/official-stockfish/Stockfish) (via npm `stockfish`) | GPL-3.0 | The Stockfish developers |
| [Lc0](https://github.com/LeelaChessZero/lc0) | GPL-3.0 | The Leela Chess Zero developers; bundled library notices accompany each platform artifact |
| [onnxruntime-node](https://github.com/microsoft/onnxruntime) | MIT | Microsoft |
| [chess.js](https://github.com/jhlywa/chess.js) | BSD-2-Clause | Jeff Hlywa |

The bundled Maia3 model (`models/maia3-5m.onnx`) is derived from
[`UofTCSSLab/Maia3-5M` at `b6559de2398d7140b985f28fd2c19fb5e47ddabe`](https://huggingface.co/UofTCSSLab/Maia3-5M/tree/b6559de2398d7140b985f28fd2c19fb5e47ddabe).
The ONNX export is a build-time step (`scripts/export_maia3.py`); the runtime
does not execute any Maia3 Python code.
