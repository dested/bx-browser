# Updates

## 2026-08-07 — agent debuggability + Opus tier (SceneBeans canvas shakedown)
Canvas-first app (WebGL, 0/3 tasks) exposed black-box failures: added always-on
turn transcripts (~/.bx/agent-runs/<ts>.jsonl, path in trailer), synthesized
fail reports on turn exhaustion (last actions as evidence, never bare
maxTurns), informed escalation (prior summary + last 5 actions), --max-turns
(default 40) + --verbose, agent bx_js + canvas system-prompt guidance, and
opt-in Opus 4.8 tier (--opus = final sonnet->opus rung; --model opus direct).
Skill/README updated; live-proven on fixture game (Haiku PASS $0.065).
Per plans/2026-08-06-scenebeans-canvas-gamedev-test.md (re-test pending).
Touched: src/agent/{driver,tools}.ts, src/cli.ts, src/protocol.ts, skill/,
README.md

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
