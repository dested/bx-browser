# Updates

## 2026-08-07 — Round-2 response: cost governance + pointer drag + tab-steal fix
--budget <usd> / --max-wall <s> abort mid-rung across the WHOLE ladder with a
synthesized fail report (trailer gains ended=budget|wall|stall|turns|error;
est spend from per-tier pricing, cache reads at 10%); stall detection (<=3
distinct calls in a window of 8 = end rung early, escalate); heartbeat line
every 10 turns (off under --json); escalations open a fresh tab AT the prior
rung's last URL (UrlTracker) instead of about:blank; wayfinding system prompt
(map window.__* first, prefer store actions/deep-links over pixel guessing).
drag --pointer: press-and-settle PointerEvents (~120ms hold, capture-correct
delivery) — the real DnD discriminator is timing, not event type (see
decisions.md); --hold/--step-delay knobs carried through flows save->replay.
Agent tabs now background: never steal the operator's active tab; tabClose
re-anchors by page identity. Fixture pointer-intent shelf + 3 smoke tests.
Live-proven: budget abort at turn 1 (ended=budget), stall->escalate, heartbeat
+ escalated PASS at $0.18 under a $0.25 budget. tsc clean, 21/21 tests.
Touched: src/agent/{driver,tools}.ts, src/cli.ts, src/protocol.ts,
src/daemon/session.ts, src/flows/{api,synthesize}.ts, fixtures/, tests/,
skill/SKILL.md (synced)

## 2026-08-07 — agent debuggability + Opus tier (SceneBeans canvas shakedown)
Canvas-first app (WebGL, 0/3 tasks) exposed black-box failures: added always-on
turn transcripts (~/.bx/agent-runs/<ts>.jsonl, path in trailer), synthesized
fail reports on turn exhaustion (last actions as evidence, never bare
maxTurns), informed escalation (prior summary + last 5 actions), --max-turns
(default 40) + --verbose, agent bx_js + canvas system-prompt guidance, and
opt-in Opus 4.8 tier (--opus = final sonnet->opus rung; --model opus direct).
Skill/README updated; live-proven on fixture game (Haiku PASS $0.065).
Touched: src/agent/{driver,tools}.ts, src/cli.ts, src/protocol.ts, skill/,
README.md

RE-TEST (Round 2, same 3 SceneBeans tasks): debuggability P0 VERIFIED FIXED —
every run now ends with a synthesized fail report + transcript; diagnosed all 3
from outside. bx_js used hard (59x on the Opus build; reads
__studio.getState().project.scenes). Tasks still 0/3, but for now-visible
reasons: (A) walkable-trail home = no DOM/affordance to open a game, blind
agent can't find the node; (B) StickerShelf pointer-intent drag (touch-none +
mostly-vertical-pull) no-ops under Playwright mouse.* drag; (C) cost inverted —
3-rung ladder to exhaustion = $0.72-$1.65/run (build 10.7min). New P0 = cost
governance (--budget + stall-detected early escalation) + a pointer-event drag
mode + canvas *wayfinding* guidance (prefer app-nav handles over blind clicks).
Full write-up + Round 3 bar in plans/2026-08-06-scenebeans-canvas-gamedev-test.md.

## 2026-08-06 — shakedown fixes, tab isolation, canvas verbs, landing site
Real-app shakedown (Coterie) drove the roadmap: fixed --save flows (passing
expects now logged + synthesized; bx run resolves "bx/flow" anywhere via
entry-file onLoad rewrite — Bun onResolve can't see bare specifiers), MSYS
path-mangling auto-repair, --help short-circuit, --json ms + BX_TIMING=1.
Made agent concurrency a real guarantee: stable tab ids, per-page ref
registries, every agent pinned to its own tab (closed in finally). Added
canvas/gamedev verbs (mouse/drag/key/wheel, element-relative via --in) +
fixture #/game + 3 smoke tests (18/18 green). Rewrote SKILL.md agent-first.
Built site/ (Vite+React+Tailwind) — interactive terminal, transcript race
with live app screens, no-magic artifacts, agent-mode showcase — and DEPLOYED
to https://bx.dested.com via drydock (project "bx", static/xs, rootDir site;
drydock owns root Dockerfile/drydock.yaml/.github). bx linked globally +
skill installed.
Touched: src/** (protocol, session, daemon, cli, flows, agent), fixtures/,
tests/, skill/, site/**, README.md

## 2026-08-06 — recording pipeline + comparison blog post
Landed record start/stop: relaunch-cycle video capture, in-browser
video-to-prompt distill via /harness routes, action log grafted as timed
transcript (passwords redacted). E2e verified on fixture: full package
(raw.webm + keyframes + contact sheet + report.md) in 3.4s at record stop.
Blog post drafted+committed in casualdeveloper.net (not deployed).
Touched: src/daemon/record.ts, src/daemon/harness/harness.ts, session.ts,
daemon.ts, scripts/build-harness.ts
Per plans/2026-08-06-bx-architecture.md (now done).

## 2026-08-06 — build bx v1 (fable-opus, 5 Opus agents)
Full v1: node daemon + distiller + observers, CLI + flows + synthesis, Agent
SDK driver (Haiku→Sonnet), bench + 10-test smoke suite, skill + docs + fixture.
Fixed: daemon must run under Node (Bun CDP pipe broken on Windows) and be
spawned detached via node:child_process. Measured: 730ms cold start, els 61×
cheaper than raw DOM, flow replay 0 tokens, Haiku agent pass $0.037.
Touched: src/**, fixtures/, flows/, skill/, tests/, scripts/ (initial build)
Per plans/2026-08-06-bx-architecture.md (recording + blog still open).
