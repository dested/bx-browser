# Verify

- **[cheap] Typecheck:** `bun x tsc --noEmit` — must be silent. Always run.
- **[cheap] CLI alive:** `bun src/cli.ts help` exits 0.
- **[medium] Smoke suite:** `bun test tests/smoke.test.ts` — 10 tests, ~5s,
  boots a headless daemon on profile "bxtest", drives the fixture app.
  Run after touching daemon/, cli, client, or flows.
- **[medium] Bench:** `bun run bench` — writes bench-results.json; compare
  cold start (~0.7s) and els economics against the committed baseline.
- **[heavy — ask first] Agent bench:** `bun run bench -- --agent` (or
  `bun src/bench/bench.ts --agent`) — spends real subscription tokens on a
  live Haiku run (~30k tokens).
- **[medium] Recording e2e:** start daemon, `bx open <fixture>`,
  `bx record start t1`, a couple of clicks, `bx record stop` — expect
  recordings/t1/report.md + raw.webm. Needs playwright ffmpeg (auto-installed
  on first use).

Test account (fixture only): demo@taskbox.test / hunter2.
