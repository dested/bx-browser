# Verify

- **[cheap] Typecheck:** `bun x tsc --noEmit` — must be silent. Always run.
- **[cheap] CLI alive:** `bun src/cli.ts help` exits 0.
- **[cheap] Debug surface:** with a daemon up (`bx els` spawns one),
  `curl -s -H "x-bx-token: <token>" http://127.0.0.1:<port>/debug`
  using `token`/`port` from ~/.bx/run/<profile>.json — expect `"ok":true`,
  `gcExposed:true`, the last command in `recent` with your Claude session in
  `clients`. Or just run `destedtui --bx` and look.
- **[cheap] Unit tests, no browser:** `bun test tests/actionLog.test.ts tests/record.test.ts tests/flows.test.ts`.
  Always after touching daemon/actionLog.ts, record.ts or flows/.
- **[medium] Smoke suite:** `bun test tests/smoke.test.ts` — 21 tests, ~11s,
  boots a headless daemon on profile "bxtest", drives the fixture app.
  Run after touching daemon/, cli, client, or flows.
- **[medium] Bench:** `bun run bench` — writes bench-results.json; compare
  cold start (~0.7s) and els economics against the committed baseline.
- **[heavy — ask first] Agent bench:** `bun run bench -- --agent` (or
  `bun src/bench/bench.ts --agent`) — spends real subscription tokens on a
  live Haiku run (~30k tokens).
- **[medium] Recording e2e:** on your own `--profile <p> --headless`:
  `bx open <fixture>/#/login`, type into email, `bx tab new <fixture>`, `bx tab 0`;
  then `bx record start t1` (answers in ~150 ms wall, "first frame in N ms"),
  a click and a fill, `bx record mark "signed in"`, `bx record stop` (~130 ms
  wall). Expect recordings/t1/ with video.webm (ffprobe: VP8, plays),
  transcript.txt (action log + "— mark: signed in", mm:ss.mmm stamps),
  recording.json; report.md lands a second or two later (`bx record status`
  lists it under "distilling" until then; no "spoken"/"speaker" in it). `bx tabs`
  still shows both tabs and the typed email survives. `bx record stop --mp4`
  adds video.mp4 (needs ffmpeg with libx264 on PATH). Ring: `bx record start t2
  --ring 30`, act, `bx record save --last 5`, `bx record stop`. Live suite:
  `BX_RECORD_LIVE=<p> bun test tests/record.test.ts`. Needs Playwright's
  ffmpeg (auto-installed on first use).
- **[cheap] bx.exe parity:** `bun run build:frontdoor`, then
  `BX_PARITY_PROFILE=<p> bun test tests/argv.test.ts` — 0 diffs between
  `dist\bx.exe` and `bun src/cli.ts` (human and --json).

Test account (fixture only): demo@taskbox.test / hunter2.
