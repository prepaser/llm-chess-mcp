# llm-chess-mcp

An MCP chess runtime that lets LLMs play, analyze, and adapt their strength
without outsourcing every decision to an engine.

Rather than returning a single best move, it exposes objective strength
(Stockfish), human move likelihood (Maia3), and real-game statistics (Lichess)
so the LLM can choose how it wants to play. The LLM does the strategy and
judgment; the MCP server handles all the computation.

## Engines

| Engine | Role | Runtime |
|---|---|---|
| **Stockfish 18** (WASM) | Objective evaluation, best moves, multipv | In-process (npm `stockfish`) |
| **Maia3 5M** (ONNX) | Human-like move probabilities conditioned on Elo | In-process (`onnxruntime-node`) |
| **Lichess explorer** | Real human game statistics | HTTP (needs token) |

Everything runs inside the Node process — no external engine process or Python
runtime is required at deploy time. The published package bundles the Maia3 5M
model; other export variants are not runtime options unless their ONNX files are
provided separately.

## Install

Requires Node.js 20 or newer.

No install needed — run it directly with `npx`:

```bash
npx -y llm-chess-mcp
```

The Maia3 model is already bundled, so there's no Python, torch, or engine
binaries to install. `npx` fetches the package on first run and caches it.

To install it permanently instead:

```bash
npm install -g llm-chess-mcp
```

### Build from source

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm test:unit` runs the unit suite. `pnpm test:e2e` builds first, then runs
the MCP transport tests. `pnpm check` runs the full local gate; use
`pnpm release:check` before publishing.

### Maintainers

[Architecture](docs/architecture.md) describes runtime and service boundaries;
[the changelog](CHANGELOG.md) records client-visible changes.

Local quality commands:

```bash
pnpm typecheck
pnpm test:coverage
pnpm contract:check
pnpm check
```

### Export Maia3 to ONNX (build-time only)

This step needs Python + PyTorch once. It downloads the Maia3 checkpoint, verifies
the reimplementation against the original, and exports `models/maia3-5m.onnx`.

```bash
uv venv .venv-maia3 --python 3.13
uv pip install --python .venv-maia3/bin/python -r scripts/requirements.txt
uv pip install --python .venv-maia3/bin/python "maia3 @ git+https://github.com/CSSLab/maia3.git@1e13597c42d4858b7cfd7cfdae01e297263364b2"
pnpm export:maia3            # -> models/maia3-5m.onnx
```

The resulting `.onnx` is committed/bundled; end users never need Python or torch.

### Lichess token (optional)

The opening explorer now requires authentication. Generate a personal access token
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
invalid requests and other 4xx responses are not retried.

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
codex mcp add llm-chess-mcp --command npx --args -y llm-chess-mcp --env LICHESS_TOKEN=your-token
```

## Tools

| Tool | Description |
|---|---|
| `create_game` | Create a game (optionally from a FEN), returns `game_id` |
| `delete_game` | Delete a game and free its session |
| `game_state` | Authoritative state: FEN, turn, revision, check/mate/draw flags, history, last move, castling (optional ASCII) |
| `game_play_move` | Play a move (SAN or UCI) — the only mutating tool, with stale-position guard |
| `game_legal_moves` | All legal moves with metadata |
| `game_pgn` | Export the game as PGN |
| `game_import_pgn` | Import a PGN into a new game |
| `position_analyze` | Stockfish multipv lines (cp/mate/WDL + PV), `analysis_level` preset |
| `human_move_distribution` | Maia3 human-move probabilities at a target Elo |
| `move_evaluate` | Score one or more moves + cpLoss + classification |
| `move_candidates` | **Primary tool**: unified candidates (objective + human + opening) |
| `move_candidates_by_intent` | Convenience layer: candidates ranked for a strategic intent |
| `opening_explorer` | Lichess human game statistics |

## Result format and 0.1.x migration

`structuredContent` is the canonical successful result. Handler-level failures
set `isError` and provide `structuredContent.error`. Input-schema failures are
generated by the MCP SDK before the handler and use its standard `isError` text
result without `structuredContent`. Otherwise, `content` is only a short
human-readable summary and must not be parsed as data.

Clients upgrading from 0.1.x should stop parsing `content` and consume
`structuredContent` instead. Check `isError` and the structured error code when
a tool fails. `move_evaluate` now always returns
`{ game_id, revision, results }`; its former single-move top-level duplicates
are removed.

## Score conventions

- Stockfish scores are **side-to-move perspective**: positive cp = side to move is
  better; `mate N` = side to move mates in N. `wdl` is `[win, draw, loss]` in
  permille for the side to move.
- `move_candidates` gives `moverCp` (the mover's perspective — higher is better
  for the player choosing the move) and `whiteCp` (fixed white perspective) so
  the sign never flips on you.
- `move_evaluate` reports the score **from the mover's perspective**, plus `cpLoss`
  (centipawns lost vs the best move) and a classification:
  `best / excellent / good / inaccuracy / mistake / blunder`.
- `maia3Prob` is a **human-likelihood**, not move quality. A high-probability move
  can still be objectively bad.

## Candidate structure

`move_candidates` returns each candidate with three independent facets:

```json
{
  "uci": "g1f3",
  "san": "Nf3",
  "objective": { "rank": 1, "moverCp": 55, "whiteCp": 55, "cpLoss": 0, "moverMate": null, "wdl": [153, 844, 3] },
  "human": { "maia3Prob": 0.62, "selfElo": 1500, "opponentElo": 1500 },
  "opening": { "status": "available", "games": 18421, "frequency": 0.31 }
}
```

- `objective` — Stockfish: engine strength, never conflated with human-likeness.
  `moverCp` is from the mover's perspective (higher = better for the chooser).
- `human` — Maia3 conditional probability at a target Elo.
- `opening` — Lichess empirical frequency (a different signal from Maia3).

`opening.status` is `available`, `no_data` (API ok but no games in this
position), `unavailable` (timeout/429/401), or `disabled` (no token).
Stockfish + Maia3 results are always returned regardless.

`move_candidates` also returns `moveSensitivity`, describing how sharply the
evaluation changes across the top engine lines:

```json
{ "moveSensitivity": { "level": "high", "topMoveSpreadCp": 245 } }
```

`level` is `low` (<80cp spread), `medium` (80–200cp), or `high` (≥200cp). High
sensitivity means choosing among plausible alternatives can materially change
the evaluation — useful for deciding whether to ease off or play precisely.

## Analysis levels

Stockfish tools accept an `analysis_level` preset instead of raw UCI knobs:

| Level | Depth | MultiPV |
|---|---|---|
| `fast` | 8 | 5 |
| `normal` | 15 | 8 |
| `deep` | 22 | 10 |

Explicit `depth`/`multipv` overrides are still available for advanced use.

## Stale-position guard

Every state read returns a `revision`. `game_play_move` **requires**
`expected_revision`; if the game has advanced since your last read, the move is
rejected:

```json
{ "error": { "code": "STALE_POSITION", "message": "position changed: expected revision 2, current 3" } }
```

## Runtime limits

- Up to 1,000 game sessions are retained; idle sessions expire after one hour.
- `move_evaluate` accepts at most 10 moves per call.
- Imported PGNs are limited to 1 MiB and 4,096 plies.
- Stockfish accepts up to 32 active or queued analyses.

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

## Maia3 ONNX verification

The exported ONNX model is regression-tested against the upstream Maia3
implementation across fixed positions and Elo pairs:

```bash
.venv-maia3/bin/python scripts/verify_maia3.py --model 5m
```

It checks top-1/top-k move agreement and max probability error to detect
export/runtime regressions. The bundled `maia3-5m.onnx` passes with 100% top-1
and top-5 agreement and max probability error < 1e-4.

## Releases

Releases are verified locally; this project intentionally has no hosted CI
release workflow.

For `0.2.0`, run `pnpm release:check`, pack the tarball, and smoke-test a clean
install of that tarball with `llm-chess-mcp`. Publish only after that succeeds.
Use the same local gate and clean-install smoke test before promoting the proven
`0.2.x` release process to `1.0.0`.

## License & attribution

This project is licensed under the **AGPL-3.0** (see `LICENSE`).

It bundles and depends on third-party components:

| Component | License | Source |
|---|---|---|
| [Maia3](https://github.com/CSSLab/maia3) (Chessformer) | AGPL-3.0 | UofT CSSLab — Monroe et al., *Chessformer: A Unified Architecture for Chess Modeling* (ICLR 2026) |
| [Stockfish](https://github.com/official-stockfish/Stockfish) (via npm `stockfish`) | GPL-3.0 | The Stockfish developers |
| [onnxruntime-node](https://github.com/microsoft/onnxruntime) | MIT | Microsoft |
| [chess.js](https://github.com/jhlywa/chess.js) | BSD-2-Clause | Jeff Hlywa |

The bundled Maia3 model (`models/maia3-5m.onnx`) is derived from
[`UofTCSSLab/Maia3-5M` at `b6559de2398d7140b985f28fd2c19fb5e47ddabe`](https://huggingface.co/UofTCSSLab/Maia3-5M/tree/b6559de2398d7140b985f28fd2c19fb5e47ddabe).
The ONNX export is a build-time step (`scripts/export_maia3.py`); the runtime
does not execute any Maia3 Python code.
