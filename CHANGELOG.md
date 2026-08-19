# Changelog

All notable changes to this project are documented here.

## [0.2.0]

### Added

- MCP tool results now declare output schemas and return their machine-readable
  payload in `structuredContent`.
- Added structured handler errors: `isError: true` and
  `structuredContent.error` contain a stable code and message.
- Added a stdio integration suite that exercises the complete registered tool
  surface through an MCP client.
- Added strict Lichess speed and rating filters, upstream-response validation,
  request deadlines, and bounded retry handling for transient explorer failures.

### Changed

- `content` is now a concise human-readable summary. Clients must consume
  `structuredContent` instead of parsing `content` as JSON.
- `move_evaluate` always returns `{ game_id, revision, results }`; the former
  single-move fields duplicated at the top level were removed.
- The Lichess opening explorer requires an access token. Missing credentials
  produce a structured disabled error while the remaining tools continue to
  work.

### Migration

- Update clients to branch on `isError` and read the structured error code.
- Treat MCP SDK input-validation failures separately: they occur before a tool
  handler runs and therefore do not include `structuredContent`.
