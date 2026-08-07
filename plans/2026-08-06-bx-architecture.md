# bx — purpose-built browser automation for Claude Code

- **Date:** 2026-08-06
- **Status:** done
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

**Two backends, one verb surface:**

- **Managed (v1, default):** Playwright + real Chrome binary
  (`channel: 'chrome'`), persistent user-data-dirs under `~/.bx/profiles/<name>`
  (`bx --profile work`). One-time sign-in per persona. Headless-able, CI-able.
  (Chrome 136+ blocks `--remote-debugging-port` on the default user-data-dir
  and app-bound cookie encryption blocks cookie import — hence managed dirs.)
- **Bridge (v2):** self-hosted companion extension sideloaded into the real
  daily-driver profiles, built on **playwright-crx** (Playwright compiled to
  run inside an extension via `chrome.debugger`). Each profile's extension
  connects out to bx's local daemon over WebSocket and registers under a
  profile name → `bx --chrome work` targets that connection. Full Playwright
  locator/auto-wait semantics inside the real logged-in profile. Caveats:
  `chrome.debugger` yellow banner, MV3 service-worker keepalive (held by the
  socket), no headless/CI, dialogs still block.

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

**Recording:** Playwright video (webm) → `dested/video-to-prompt`
(`bun add github:dested/video-to-prompt`) → agent-ready package: deduped
keyframes, 3×3 contact sheets, `report.md` built for LLM reading. The library
is **browser-only** (decodes via `<video>`/canvas/OfflineAudioContext) — bx
runs `distill()` inside an internal harness page in the browser it already
controls, and writes the package to `recordings/<slug>/` via exposed bindings.
`report.md` is the tier-2 evidence artifact. For bx-driven recordings there is
no narration — instead bx feeds its own **action log as the transcript
segments** (timed "clicked Save", "filled email"), so the report reads as a
narrated walkthrough with zero audio.

**React-specific:** mount component/route directly for screenshots; `bx watch`
re-runs flow + snap on Vite HMR.

## Decisions so far

Moved to `decisions.md` at repo root.

## Open

- Final CLI name (`bx` is working name).
- Repo visibility (created private; flip when ready).
- Bridge extension: exact keepalive strategy for MV3 worker; install story
  across 5 profiles.
