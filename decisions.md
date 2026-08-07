# Decisions

Newest first. Append-only; supersede, never delete.

## 2026-08-06 — Daemon runs under Node; everything else under Bun

**Why:** Playwright's default CDP pipe transport uses stdio fds 3/4, which Bun
on Windows does not wire up — Chrome launches but the handshake times out
(180s); under Node it connects in ~400ms. The websocket fallback also fails
under Bun (`node:http` never emits `upgrade` to Playwright's `ws`). The daemon
(src/daemon/**) is therefore runtime-neutral (node:http/node:fs, zero `Bun.*`),
spawned as `node daemon.ts` — Node 22.18+ type stripping runs the .ts files
directly, no build step. Constraint: no non-erasable TS syntax in src/daemon/**
(no parameter properties, enums, namespaces). CLI, flows, agent driver, bench
stay on Bun.
**Rejected:** running the daemon under Bun (CDP pipe broken), connectOverCDP
websocket bridge under Bun (upgrade event never fires; shimming got the
handshake but no data), bundling the daemon to JS (adds a build step for no
gain).

## 2026-08-06 — Self-healing in-place build for the video-to-prompt git dep

**Why:** `github:dested/video-to-prompt` declares `main`/`types` into `dist/`
but ships only `src/` (no build on git install), so the package is unresolvable
as installed. `scripts/build-harness.ts` detects a missing dist and runs
`bun x tsc -p tsconfig.build.json --rootDir src` inside the dep before
bundling; `skipLibCheck` keeps its emitted declarations out of our strict
program. Durable fix is a `prepare` script in the video-to-prompt repo.
**Rejected:** bundling the dep's raw src into our TS program (~25 errors under
`noUncheckedIndexedAccess`), vendoring the source (drift), publishing to npm
now (user's call, separate repo).

## 2026-08-06 — video-to-prompt runs in-browser via harness page

**Why:** `dested/video-to-prompt` is browser-only by design; bx already
controls a browser, so `distill()` runs in an internal page and writes the
package via exposed bindings. bx's action log doubles as the transcript.
**Rejected:** porting it to Node (pointless), external ffmpeg pipeline
(duplicate of a tool that already exists and is battle-tested).

## 2026-08-06 — Agent SDK for the driver session

**Why:** typed tool definitions for bx verbs, persistent session (no 2–4s
`claude -p` spawn per step), mid-session model switching for the escalation
ladder, subscription auth.
**Rejected:** `claude -p` process-per-step (spawn latency), raw stream-json
(more plumbing, fewer types).

## 2026-08-06 — Two backends: managed profiles (v1) + playwright-crx bridge extension (v2)

**Why:** Chrome 136+ blocks CDP on the default user-data-dir and app-bound
encryption blocks cookie import, so real daily-driver profiles are reachable
only from inside an extension. playwright-crx gives full Playwright semantics
via `chrome.debugger`; a self-hosted sideloaded extension per profile connects
to bx's local daemon and registers by profile name (`bx --chrome work`).
Managed persistent profiles stay the default (headless, CI, no banner).
**Rejected:** CDP-attach to real profiles (blocked by Chrome), cookie import
(blocked by app-bound encryption), extension-only design (loses headless/CI).

## 2026-08-06 — Model tiers: Haiku drives, Sonnet escalates, main model judges

**Why:** distilled ~800-token DOM snapshots + a ~12-verb action space make
compilation a constrained translation task Haiku 4.5 handles; Sonnet takes
first-failure retries and indirection; visual verdicts go to the main session
as keyframes. Tier resolution is logged per task to tune with data.
**Rejected:** Sonnet-everywhere (slower, burns quota), Haiku-only (weak on
repair/judgment).

## 2026-08-06 — CLI + teaching skill, not an MCP server

**Why:** zero schema overhead (~10 tokens per Bash call vs hundreds per tool
schema), composable, output token-budgeted at the source.
**Rejected:** MCP server (schema weight, the exact failure mode of Claude in
Chrome).

## 2026-08-06 — Flows are typed TS artifacts

**Why:** tsc catches drift, flows double as regression tests, replay costs
zero model tokens.
**Rejected:** YAML (no type safety), re-driving flows with a model every run
(the Claude-in-Chrome cost model).
