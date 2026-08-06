# claude-browser (`bx`)

Purpose-built browser automation for Claude Code. A thin CLI over Playwright +
real Chrome that replaces the Claude in Chrome extension for driving your own
apps: token-budgeted observation, deterministic replayable flows, cheap-model
authoring/repair, keyframe-based evidence.

Design principles:

- **CLI, not MCP** — zero schema overhead; a skill teaches the verbs.
- **Deterministic where possible** — flows are typed TS artifacts; replay costs
  zero model tokens.
- **Cheap model in the loop, expensive model reads the report** — Haiku/Sonnet
  compile and repair flows via headless Claude Code; the main session sees a
  ~300-token report and a handful of keyframes.
- **Text-first observation** — distilled interactive-element snapshots, hard
  token cap; pixels only on demand and at checkpoints.

Status: design phase. See `plans/2026-08-06-bx-architecture.md`.
