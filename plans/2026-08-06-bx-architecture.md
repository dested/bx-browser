# bx — purpose-built browser automation for Claude Code

- **Date:** 2026-08-06
- **Status:** active
- **Type:** plan
- **What:** Architecture and decisions for the Claude-in-Chrome replacement CLI.

## Problem

Claude in Chrome is too verbose and too expensive for the actual use cases:
building React components/screens, clicking through workflows, recording them,
verifying bugs. Root causes:

- The expensive model (Opus/Fable) sits in the per-action loop; every click is
  screenshot → reason → coordinates → screenshot (~1.1–1.6k image tokens each,
  retained in context). A 15-step flow ≈ 30–60k tokens, re-paid on every rerun.
- Vision-first `computer` tool: coordinate drift, defensive screenshots.
- `read_page` a11y dumps run 5–30k tokens; console/network are firehoses.
- ~24 MCP tool schemas in context; extension fragility (stale tab IDs, dialog
  deadlocks, per-site permissions).

## Design principles

1. Deterministic where possible; model only at compile time and failure time.
2. Text-first observation (distilled DOM, hard token cap); pixels at
   checkpoints only.
3. Cheap model drives, expensive model reads a distilled report.
4. Flows are version-controlled, replayable, typecheckable artifacts —
   regression tests for free.
5. CLI + skill, not MCP — zero schema overhead, composable in Bash.

## Architecture

**`bx` CLI** — Bun + Playwright core, driving real installed Chrome
(`channel: 'chrome'`) with **managed persistent profiles**.

- Verbs (working set): `open`, `click`, `type`, `fill`, `press`, `wait`,
  `expect`, `snap` (downscaled screenshot), `els` (distilled numbered
  interactive elements, ~500–800 token cap), `text`, `console`, `net`,
  `record start/stop`, `run <flow>`, `agent "<NL instruction>"`, `watch`.
- Element refs: `els` prints `[3] button "Sign in"` → `bx click 3`. Playwright
  locators auto-wait; no screenshot-guess-retry.
- Console/network: ring buffer, errors surfaced by default, pattern filter.

**Profiles:** named personas → persistent user-data-dirs under
`~/.bx/profiles/<name>` (`bx --profile work`). One-time sign-in per persona;
cookies persist. NOTE: Chrome 136+ blocks `--remote-debugging-port` on the
default user-data-dir, and app-bound cookie encryption (Chrome 127+, Windows)
blocks cookie import — so we can't CDP-attach to the literal daily-driver
profiles. Managed dirs with real Chrome binary is the honest path.

**Flows:** `flows/<name>.flow.ts` — tiny typed API, checked by tsc. Replay =
zero model tokens.

**Escalation ladder:**

- Tier 0: `bx run flow` — deterministic, 0 tokens.
- Tier 1: failure → headless Claude (Haiku default, auto-escalate Sonnet on
  first failure) repairs against distilled DOM. Persistent headless session per
  task (stream-json / Agent SDK), NOT process-per-step — CLI spawn is ~2–4s.
- Tier 2: visual judgment / unfixable → keyframes up to the main session.

**`bx agent "<NL>"`:** compiles instruction → flow via headless cheap model,
executes, emits ~300-token JSON report (pass/fail, console errors, keyframes).

**Recording:** Playwright video/trace → user's video-to-keyframes tool (being
built separately, external CLI) → 3–5 stills instead of live screenshot
narration. GIF/frames as byproduct.

**React-specific:** mount component/route directly for screenshots; `bx watch`
re-runs flow + snap on Vite HMR.

## Decisions so far

- Standalone repo/global CLI, reused across projects (dested/claude-browser).
- Real Chrome binary, managed persistent profiles, profile picker flag.
- Flows in typed TS (not YAML).
- CLI + teaching skill, not MCP server.
- Model tiers: Haiku default driver, Sonnet escalation, main model verdicts —
  all via Claude Code headless (subscription).

## Open

- Final CLI name (`bx` is working name).
- Persistent-session driver mechanism: `claude -p` stream-json vs Agent SDK.
- Keyframe extractor interface (user building it now).
- Repo visibility (created private; flip when ready).
