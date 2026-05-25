# Changelog

All notable changes to bikky are documented here.

This project uses npm package versions for release tracking:

- `bikky` — core CLI, MCP server, and daemon.
- `bikky-ui` — local web dashboard.

## Unreleased

## 0.4.6

- Added configurable `ignore` rules for memory writes using the same `cwd`, `entity`, `content`, and `metadata` filters as destination routing.
- Applied ignore checks before MCP writes, daemon writes, relation sidecars, superseding, telemetry upserts, embedding, deduplication, and Qdrant persistence.
- Documented ignore configuration and added regression coverage for config validation, routing precedence, MCP write paths, daemon writes, telemetry, and local MCP E2E behavior.

## 0.4.5

- Fixed destination routing so daemon provenance and agent metadata no longer influence where unrelated facts are stored.
- Added regression coverage for non-Bikky facts with Bikky daemon origin metadata.
- Moved the README top diagram closer to the audience/context section.

## 0.4.4

- Refreshed README positioning and configuration guidance for supported MCP clients, transcript capture, Qdrant storage, and built-in model providers.
- Added memory quality/usefulness signals and surfaced usefulness data in the UI.
- Fixed MCP and daemon write routing to use the full memory context consistently.
- Removed the old Human memory category and filtered internal dashboard memory rows.
- Added Playwright coverage for memory filters and edge cases.

## 0.4.3

- Fixed daemon destination routing and dynamic config-path handling.
- Added canonical origin provenance metadata to memory writes.
- Recommended Portkey as the default cloud inference provider and canonicalized 1024-dimension embedding guidance.
- Fixed `bikky-ui` browser launches when the server binds to `localhost:0`.
- Added higher-priority test coverage across core routing, config, and UI behavior.

## 0.4.2

- Republished the core package from current `main` so the npm package README uses GitHub documentation links instead of stale jsDelivr links.

## 0.4.1

- Public OSS readiness cleanup: package metadata, support docs, public maintainer ownership, package tarball hygiene, and privacy/transcript-capture documentation.
- Added package verification CI and a privacy-first quickstart for local storage/local model setups.

## 0.4.0

- Added multi-destination Qdrant routing and configurable read/search scopes.
- Added Claude Code user-scoped MCP setup support.
- Added Claude Code transcript ingestion for daemon memory extraction.
- Refreshed README screenshots, setup guidance, and configuration docs.
