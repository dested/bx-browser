# Updates

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
