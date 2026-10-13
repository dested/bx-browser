# Speed research: Chrome, .NET and recording

- **Date:** 2026-10-12
- **Status:** active
- **Type:** analysis
- **What:** scout's measured answers to the three open questions in G:\code\bx\plans\2026-10-12-audit-implementation.md (Chrome faster and lighter, where .NET wins, a recording redesign), with what to build

Machine: i9-14900K, 128 GB, RTX 4090, Windows 11 Pro 10.0.26300. Chrome 155.0.8059.40, chrome-headless-shell 155.0.8059.39, playwright-core 1.62.1, Node 22.22.2, Bun 1.3.10, .NET SDK 10.0.401. Every Chrome launch in these benches ran `seedOsPasswordCheck` first and refused to launch unless it returned "written" or "already current". Numbers are medians unless noted. "CPU %" means percent of one core. Memory is private MB summed over the browser's process tree.

## Recommendations

| # | Change | Measured gain | Risk | Effort |
|---|---|---|---|---|
| 1 | **V1: record one tab with raw CDP `Page.startScreencast`, piped live into our own ffmpeg. No context relaunch** | Start: 0.3–1.8 ms, against 0.50–0.54 s at the CLI today (fleet median 1.06 s, p90 11.5 s). Stop: 34 ms plus the package write, against 1.2 s for a 5 s clip and 7.45 s for a 75 s clip today (fleet median 5.6 s, p90 23 s). Tabs, typed values and page ids survive. A 60 fps page costs 58% of a core, against 82% for today's `recordVideo` with 2 tabs and 101% for `page.screencast` to a file | Medium. It rewrites record.ts, and it must never run alongside `recordVideo` or `page.screencast`. Headed windows that are on screen but covered, or minimized, are untested; off-screen and background tabs work | M–L |
| 2 | **Rolling ring and `bx record save --last N`, built on 1** | 48–49 KB/s of JPEG on a typical app page. 664 KB/s for a 60 fps page captured at 30 fps. Encoding 10 s of ring at save takes 0.58–1.0 s. Stopping the ring takes 0.3 ms | Low. Cap the ring by bytes and by seconds | S after 1 |
| 3 | **Thin NativeAOT `bx.exe` front door.** It posts argv to the daemon and hands `run`, `agent` and `bench` to `bun cli.ts` | 24 ms per call, against 92–94 ms for the working-tree CLI (after S2) and 118 ms for bx-live. No TypeScript client measured below 66 ms: the Bun `--compile` exe takes 78 ms. Across the 250,847 logged calls, the saving is about 4.7 h | Medium: a second language in the repo, plus a build step. **This is the .NET case, and Sal decides** | M |
| 4 | **Click fast path.** Our own visible, enabled and hit-test check, then a trusted `mouse.click`, falling back to `locator.click` | 2.4–2.5 ms against 33.2 ms per click. The 31 ms is Playwright's actionability wait (the "stable" check spans two frames) | Medium. A moving element can be misclicked, so fall back when it has running animations or the hit test fails | S |
| 5 | **Cold-start trims.** Import playwright-core and launch Chrome right after `listen`, call `module.enableCompileCache()`, and poll the client every 15 ms instead of 100 | Today: 805–833 ms from cold to the first result. The import takes 225–234 ms, or 181–194 ms with the compile cache. About 281 ms passes between "listening" and the seed line. Expected saving 150–300 ms (an estimate; the parts were measured, not the whole) | Low | S |
| 6 | **Disk: rely on D1 `bx gc --caches`, not on D2's cap. Add `BrowserMetrics\` and `BrowserMetrics-spare.pma` to `CACHE_DIRS`** | `--disk-cache-size` is only loosely honored: a 1 MB cap left 8.5 MB (14.1 MB uncapped), and a 10 MB cap left 27.6 MB (28.6 MB uncapped). Fleet: 45 GB in 504 profiles. The folders D1 already clears hold 38.9 GB. BrowserMetrics holds another 3.8 GB | Low: these are rebuildable files with no logins | XS |
| 7 | Optional: **chrome-headless-shell with `--use-angle=d3d11`, for headless daemons only** | Launch 101 ms against 218–242 ms. Idle 128 MB against 228 MB. 9 tabs 755 MB against 790–820 MB | Medium. A second 280 MB binary that must stay on Chrome's version. Only 17% of daemon starts are headless. The plain shell runs WebGL on SwiftShader at about 900% of a core | M |

### Measured and rejected

| Candidate | Measured | Why not |
|---|---|---|
| The brief's flag set: `--disable-background-networking`, `-component-update`, `-default-apps`, `-sync`; Translate, OptimizationHints and MediaRouter | Playwright already passes all of them | No-op. Adding any `--disable-features=` **replaces** Playwright's 16-entry list, because Chrome keeps only the last such switch (verified with ThirdPartyStoragePartitioning). Merge into Playwright's list or don't touch it |
| `--renderer-process-limit=2` | One tab 441 MB vs 459. Per extra tab +36 MB, unchanged | No gain |
| `--process-per-site` | +13 MB per extra same-site tab, vs +36 | A hung tab blocks every tab on the same site, which breaks tab pinning |
| Site isolation off | +35 MB per tab with 3 cross-site iframes, vs +61. 9 tabs 728 MB vs 820 | Gives up isolation in logged-in sessions to save 26 MB per iframe-heavy tab |
| `--js-flags=--max-old-space-size` | Idle and one tab unchanged (460 MB) | Caps only the worst case, and can OOM real apps |
| `--disable-gpu` | −85 MB per browser (one tab 374 MB) | WebGL falls back to SwiftShader at about 900% of a core at 60 fps (measured on Chrome) |
| `--disable-gpu-vsync` and no frame-rate limit | Click 17.5 ms vs 33 | An animated page ran at 4,798 fps on 445% of a core |
| Disable the spare renderer | Idle −7 MB, one process fewer | Noise-level |
| Pre-warmed spare tab for `tabNew` | Saves about 20 ms (`newPage` takes 14–34 ms) | Only 671 `tabNew` calls in every log: about 13 s in total |
| Raw CDP `Runtime.evaluate` instead of `page.evaluate` | 0.2–0.4 ms vs 0.3–0.5 ms | Playwright's overhead is 0.1 ms |
| "Lean" set: cache cap, no GPU shader disk cache, extra disabled features | Profile 15 MB → 8 MB after one session. Nothing else moved | Row 6 covers it. A shader disk cache off means WebGL shaders recompile each launch |
| A .NET daemon speaking CDP | Estimated 80–100 MB less per daemon. Latency gain 0.1 ms per call | It would mean rewriting Playwright (locators, actionability, frames, input, dialogs, screencast). See Q2 |
| Job objects to clean up orphan Chrome | libuv already puts non-detached children in a kill-on-close job. Hard-killing the daemon took its Chrome down in 363 ms | Already done |
| A tray monitor | Already exists (sal-widgets `BxWatch.cs`, destedtui) | Already done |

## Q1: Chrome faster and lighter

### Launch candidates

Each candidate was launched in-process with `launchPersistentContext` on a fresh scratch profile and driven through the same steps: 5 cold launches, 5 warm relaunches, 100 evaluates, 30 clicks, an animated page, 6 same-site tabs, and 9 tabs that each embed 3 cross-site iframes.

| Candidate | Launch → first evaluate | Idle | 1 tab | Per extra same-site tab | Per extra tab with 3 cross-site iframes | 9 iframe tabs | Profile after the session |
|---|---|---|---|---|---|---|---|
| Chrome `--headless` (today's headless) | 218–242 ms | 228 MB / 8 procs | 417–459 MB | +36 MB | +61 MB | 790–820 MB / 19 procs | 15.2 MB |
| Chrome headed (today's default, 83% of starts) | 257 ms | 256 MB | 521 MB | +53 MB | +70 MB | 996 MB | 35.2 MB (BrowserMetrics 20 MB) |
| chrome-headless-shell | 105–116 ms (warm 92) | 71 MB / 4 procs | 269–276 MB | +34 MB | +37 MB | 553–560 MB / 12 procs | 6.9 MB |
| shell `--use-angle=d3d11` | 101 ms (warm 93) | 128 MB | 496 MB* | +30 MB | +36 MB | 755 MB | 6.9 MB |
| Chrome `--disable-gpu` | 249 ms | 154 MB | 374 MB | +31 MB | +53 MB | 686 MB | 11.1 MB |
| Chrome site isolation off | 229 ms | 212 MB | 445 MB | +36 MB | +35 MB | 728 MB | 15.2 MB |
| Chrome `--process-per-site` | 279 ms (warm 230) | 232 MB | 459 MB | +13 MB | +46 MB | 661 MB | 15.2 MB |
| Chrome `--renderer-process-limit=2` | 251 ms (warm 224) | 214 MB | 441 MB | +36 MB | +63 MB | 811 MB | 15.2 MB |
| Chrome heap limit | 227 ms | 228 MB | 460 MB | +36 MB | +65 MB | 835 MB | 15.2 MB |

\* After WebGL work: the GPU process alone is 244 MB.

**WebGL** (a full-screen shader, 3 s):

| Browser | Frame rate | CPU | Renderer |
|---|---|---|---|
| Chrome `--headless` | 60 fps | 13% | the RTX 4090 |
| shell `--use-angle=d3d11` | 60 fps | ~5% | the RTX 4090 |
| plain shell | 60 fps | ~900% | SwiftShader |
| Chrome `--disable-gpu` | 60 fps | ~900% | SwiftShader |

**chrome-headless-shell: what it could break**

- **Logins.** None found. Cookies and localStorage carry over in both directions between headed Chrome 155 and shell 155 on one profile. A profile written by a newer Chrome may not open in an older shell, so the two binaries must move together.
- **Extensions.** No difference in practice: Playwright already passes `--disable-extensions`.
- **GPU and canvas.** It falls back to SwiftShader unless it gets `--use-angle=d3d11`. That flag costs +57 MB idle for the GPU process.
- **Video.** H.264 and AAC are present. Screencast on the shell was not measured.
- **Fidelity.** Cross-site iframes share a process in the shell (no site isolation). The user agent says HeadlessChrome and `navigator.webdriver` is true, the same as Chrome `--headless`.
- **Password seed.** The shell's binaries contain no `os_password_blank` code (Chrome's chrome.dll has it), so the shell cannot trigger the lockout. Keep seeding anyway, so the profile stays safe to open in headed Chrome.
- **Cost.** 280 MB unpacked, installed per machine.
- **Recommendation.** Worth it only if headless becomes the default. Today it saves about 120 ms and about 100 MB on 17% of daemon starts.

### Per-command costs (Chrome `--headless`, in process)

| Operation | Median | Note |
|---|---|---|
| `page.evaluate("1")` | 0.3–0.5 ms | raw CDP `Runtime.evaluate` takes 0.2–0.4 ms |
| `locator.click` | 33.2 ms | `trial: true` costs the same: it is all actionability |
| `locator.click({force})` | 2.4 ms | |
| hit test + `page.mouse.click(x, y)` | 2.5 ms | recommendation 4 |
| raw CDP press and release | 0.6 ms | |
| `mouse.move` | 16.7 ms | Blink waits for the next frame. Raw CDP is the same |
| key press | 0.5 ms | |
| screenshot | 31.8 ms | measured before S4 |
| els on the fixture | 0.6–1.1 ms | |
| els on 2,000 elements | 1,110–1,200 ms | measured before 4739d97. Resolver reports 6,000 elements going from 1,440 to 13 ms |
| `newPage` | 14–34 ms | |
| daemon `/cmd` `js 1` over HTTP from a warm process | 1.1 ms | status and tabs: 0.9 ms |

### Real cold start (bx-live CLI, headless)

- **Timings.** 805–833 ms to the first result on a fresh profile. About 800 ms to restart on an existing profile. The next command takes 125–132 ms.
- **Daemon log breakdown.**
  - About 281 ms from "listening" to the seed line. This is the client's 100 ms poll, its POST, and the lazy `import("playwright-core")` (`G:\code\bx\src\daemon\session.ts:759`).
  - Then about 236 ms of Chrome launch.
- **Import costs.**
  - playwright-core costs 225–234 ms under Node. With `NODE_COMPILE_CACHE` it costs 181–194 ms.
  - `node -e 0` takes about 60 ms.
- **Where to cut.** The daemon (`G:\code\bx\src\daemon\daemon.ts:467`) still waits for the first command before it imports and launches, and `START_POLL_MS` is still 100 (`G:\code\bx\src\client.ts:129`). Starting both right after `listen` overlaps them with the client's poll and POST.
- **Fleet logs.** 1,317 daemon starts, 224 of them headless. About 1,820 browser launches.

### Disk

- **Fleet.** 504 profiles holding 45 GB:

  | Folder | Size | Share |
  |---|---|---|
  | `Default\Cache` | 22.4 GB | 49% |
  | `Default\Code Cache` | 12.3 GB | 27% |
  | `BrowserMetrics\` + `BrowserMetrics-spare.pma` | 3.8 GB | |
  | `GrShaderCache` | 2.6 GB | |
  | `Default\GPUCache` | 1.6 GB | |

- **Cache per profile.** p50 26 MB, p90 99 MB, p99 271 MB, max 359 MB (the "default" profile, which uses the blockfile backend).
- **What a cap could save.** A fully enforced 64 MB cap would shrink 102 profiles and save 6.8 GB. A 32 MB cap would save 11.6 GB.
- **`--disk-cache-size` is loosely enforced.** The switch reaches the browser process's command line but not the network service's.
  - A 1 MB cap gave 8.5 MB after 5 pages, against 14.1 MB uncapped.
  - A 10 MB cap gave 27.3 MB of `Cache` after a 23–26 s browse, against 30.4 MB uncapped (`profile-growth.mjs`). After two sessions it gave 27.6 MB, against 28.6 MB (`cache-cap2.mjs`).
  - So D2 (`G:\code\bx\src\daemon\session.ts:768`, 64 MB) is harmless but won't deliver much.
- **D1 is the lever.** `CACHE_DIRS` (`G:\code\bx\src\maintenance.ts:32`) already covers Cache, Code Cache, GPUCache, GrShaderCache, ShaderCache and CacheStorage. Add `BrowserMetrics` and `BrowserMetrics-spare.pma`: they hold no logins and come back on launch. Disabling the `PersistentHistograms` feature did not stop BrowserMetrics.
- **`--disable-gpu-shader-disk-cache`** saves 5–7 MB per profile, at the cost of recompiling WebGL shaders every launch.

## Q2: .NET

### (a) A NativeAOT client

- **What it is.** `bxc.exe` (4.7 MB, `PublishAot`, `InvariantGlobalization`) reads `C:\Users\dested\.bx\run\<profile>.json` with `Utf8JsonReader`, posts one `/cmd` over a raw socket (or `HttpClient` with `--http`), and prints the value.
- **Method.** Every client posted `js 1` to the same running headless daemon. 25 runs after 3 warm-ups. The second run interleaved the candidates.

| Client | First run | Interleaved run |
|---|---|---|
| `bun -e 0` (floor) | 70.0 ms | 67.7 ms |
| `node -e 0` (floor) | 43.6 ms | |
| bx-live CLI (a80f037) | 117.7 ms | |
| bx working-tree CLI (after S2) | 93.4 ms | 91.8 ms |
| minimal Bun `fetch` | 79.6 ms | 78.6 ms |
| minimal Bun, `bun build --compile` exe | | 78.3 ms |
| minimal Node `fetch` | 74.4 ms | |
| minimal Node `node:http` | 65.8 ms | |
| `curl.exe` (native floor) | 21.4 ms | 21.7 ms |
| **NativeAOT, raw socket** | **23.7 ms** | **24.1 ms** |
| NativeAOT, `HttpClient` | 28.0 ms | |

- **Can TypeScript get there?** No. The stack's floor is the runtime's own start-up: 66 ms for the best Node client, 78 ms for Bun even as a compiled exe. Native gets within 2 ms of curl.
- **The saving.** 68 ms per call against the working-tree CLI, 94 ms against bx-live. Over the 250,847 logged calls, that is about 4.7 h (6.5 h against bx-live). S3 batching already helps chained calls. The front door is for single calls, which is how agents call bx: one Bash call, one process.
- **Proposed shape.**
  - `bx.exe` posts `{argv, cwd}` to a new daemon `/argv` endpoint, where parsing and formatting stay in shared TypeScript. The daemon returns `{stdout, stderr, exit}`.
  - When no daemon is up, or the command is `run`, `agent` or `bench`, `bx.exe` executes `bun G:\code\bx\src\cli.ts` with the same arguments. That costs about 80 ms extra, only on those calls.
- **Not measured.** The `/argv` route end to end. The number above is the AOT client posting `/cmd`.

### (b) A .NET daemon speaking CDP directly

- **Memory.**
  - The Node daemon: 117 MB private (RSS 124 MB, V8 heap 55 MB).
  - Bare Node is 50 MB RSS. playwright-core adds about 61 MB and zod about 12 MB.
  - An idle NativeAOT TCP server is 4.8 MB private.
  - So a realistic .NET CDP daemon would be about 20–40 MB (an estimate): about 80–100 MB saved per daemon. Next to Chrome's 228–996 MB, that is 7–29% of daemon plus browser.
- **Latency.** No gain. The HTTP `/cmd` floor is 0.9–1.1 ms, and Playwright adds 0.1 ms over raw CDP.
- **Cold start.** About 300 ms of the 800 ms is Node plus imports, and most of it can be won back in Node (recommendation 5).
- **Cost.** A rewrite would reimplement Playwright: role and text locators, actionability, frames, iframes and shadow DOM, input, dialogs, downloads, screencast, and persistent-context launch. PuppeteerSharp has no role locators or actionability. Microsoft.Playwright for .NET runs the same Node driver, so it saves no memory.
- **Verdict: no.**

### (c) Anything else

- **Orphan Chrome.** Not needed. libuv already places non-detached children in a kill-on-close job object (with silent breakaway). Hard-killing the daemon took its Chrome down in 363 ms, and no orphans existed at test time. `G:\code\bx\src\daemon\orphans.ts` (R2) covers stale locks. Keep Chrome spawned non-detached.
- **Tray monitor.** Already exists: sal-widgets `BxWatch.cs` and destedtui.
- **Verdict: the front door in (a) is the only place C# clearly wins.**

## Q3: recording (V1)

### The current flow, run once on the fixture

The run used bx-live (a80f037), headless, with the scout-rec profile. Setup: the fixture in tab 0, a typed but unsent email, a JS global, and a second tab. Then `record start`, fill, fill, click ×3, `record stop`.

1. **`record start` relaunches the context.** It took 0.50–0.54 s here. Across the fleet the median is 1.06 s and p90 is 11.5 s. Only the active tab's URL survives: the second tab, the typed value and the in-memory state are gone, and page ids change.
2. **`record stop` relaunches again, then runs distill in a browser before it returns.** It took 1.2 s for a 5 s clip and 7.45 s for a 75 s clip. Across the fleet the median is 5.6 s, p90 is 23 s and the max is 177 s.
3. **It fails often.** 24 of 370 fleet starts failed. Among them: 12 "no video captured", 7 launch failures during the relaunch, and 1 distill timeout.
4. **Every open page gets its own ffmpeg** (VP8, 25 fps constant frame rate). The video to keep is then chosen by action count, so the wrong tab can be picked.
5. **The package holds the video twice.** `raw.webm` and `rec-01\walkthrough.webm` are the same bytes (66 KB and 720 KB in the two runs).
6. **The report describes an action log as a narrated human walkthrough.** It says "5 spoken line(s)", "speaker", and "speech recognition mangles…". That misleads the agent reading it.
7. **Missing features.** No markers, no "save the last N seconds", no way to pick a tab, no mp4.
8. **Leaks (fixed going forward).** `C:\Users\dested\.bx\tmp-video` holds 17 leaked scratch folders (127 MB) dating back to 2026-08-07. D3 (6c13b46) cleans up in a `finally` from now on, and `bx gc` sweeps the old ones.

The side finding from this run is in the side findings section (`fill` on a missing target).

### Prototype: raw CDP screencast without a relaunch

Method: `context.newCDPSession(page)`, then `Page.startScreencast` with JPEG frames acked on arrival. Frames go either into a memory ring or live into Playwright's ffmpeg, using the same VP8 settings as `recordVideo` and the same constant-frame-rate duplication.

**Start, stop and frame rate (headless):**

| Measure | Result |
|---|---|
| Start call | 0.3–1.8 ms |
| First frame | 11–31 ms |
| Stop, ring | 0.3 ms |
| Stop, with our live ffmpeg | 34 ms |
| Stop, `page.screencast` writing a file | 100–225 ms |
| Typical app page (fixture, actions every second) | 3.1–3.2 fps (Chrome only sends frames on damage), 48–49 KB/s of JPEG, about 15 KB per frame. A 10 s VP8 file is 171–185 KB. Extra Chrome CPU 0–5%, ffmpeg about 8% |
| Tab switch (re-target the screencast) | 0.4–0.9 ms per call. The longest frame gap was 32–63 ms |
| Background tab | 176–177 frames in 3 s. Playwright's `--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows` keep it painting |

**CPU on a 60 fps animated page** (medians of 3 interleaved rounds, 8 s each):

| Variant | Chrome | Node | ffmpeg | Total | Output |
|---|---|---|---|---|---|
| No capture | 4.7% | 0.2% | | 5% | |
| `page.screencast` to a file (every frame, q90) | 78.9% | 3.3% | 19.3% | **101%** | 1.1 MB per 8 s |
| raw CDP, every frame, q70, to the ring | 60.9% | 3.9% | | 65% | 60 fps, 1.3 MB/s |
| raw CDP, `everyNthFrame: 2`, q70, to the ring | 40.0% | 0.6% | | 41% | 30 fps, 664 KB/s |
| **raw CDP, n2, live VP8** | 35.7% | 2.2% | 19.7% | **58%** | 30 fps, 1.1 MB per 8 s, stop 34 ms |
| today: `recordVideo` relaunch, 2 tabs | 57.8% | | 24.4% (2 encoders) | **82%** | relaunch 235 ms, close and flush 791 ms |

**Headed (window parked off-screen at −2600,−2600):**

- Raw CDP delivered 239 frames in 4 s on the foreground tab and 176 frames in 3 s on a background tab. A tab switch left a longest gap of 33 ms.
- **Playwright's `page.screencast` `onFrame` never fired in headed Chrome:** 0 callbacks in 4 s, while its own file writer received 123 real frames. That is another reason to use raw CDP. My earlier "0 frames headed" reading came from this callback, not from Chrome.

**Codecs** (re-encoding the same captures with the system ffmpeg 7.1.1, which is on PATH on this machine):

| Clip | VP8 webm (Playwright's ffmpeg) | H.264 (libx264 veryfast crf 28) | NVENC | VP9 |
|---|---|---|---|---|
| 10 s app clip | 175 KB | **39 KB** | | |
| 8 s animation | 1.13 MB | 1.15 MB | 1.7 MB | 1.3 MB |

Playwright's bundled ffmpeg (`ffmpeg-1011`) can only encode VP8 to webm or write PNG.

**Encoding a 10 s ring at save time:**

- Single-thread VP8: 0.58–0.66 s for the app page, 1.0 s for the animation.
- A full 120 s ring of animation would take about 12 s at single thread. Use `-threads 4`, or x264 when it's available.

**Other measurements:**

- `page.screencast.showActions({duration: 500})` made each click take 546 ms instead of 33 ms: it waits out the full duration on every action. Don't use it.
- Every output was valid VP8 webm (checked with ffprobe), the same codec that distill reads today.

### Design: the replacement

**Commands.** All of them answer in milliseconds, and none relaunches.

- `bx record start [slug] [--tab <id> | --follow] [--ring <secs>] [--fps 30|60]`
  - Captures one tab: the active tab by default, or a pinned tab with `--tab`.
  - `--follow` re-targets on `tab` switches. The re-target costs under 1 ms with a gap of at most 63 ms.
  - Wrong-tab picks become impossible, because nothing is chosen afterwards.
  - Fails loudly if no frame arrives within 1 s. The first frame normally lands in 11–31 ms.
- `bx record mark "<text>"`
  - Writes a `mark` entry to the action log, which becomes a chapter in the report. No in-page overlays.
- `bx record stop`
  - Stops the screencast and closes the encoder (34 ms).
  - Writes the video, `transcript.txt` and `recording.json`, and returns their paths at once.
  - Distill runs in the background, or waits when `--distill` is given.
  - `bx record distill <slug>` re-runs it.
- `bx record save --last N [slug]` (ring mode)
  - Encodes the last N seconds of the ring.
  - Default caps are 120 s and 64 MB, dropping the oldest frames first. That holds about 98 s of a 60 fps page at n2, or the full 120 s of a typical app page.
- `bx record status`

**Capture core.** About 60 lines, already prototyped in `liveEncoder()` in `screencast-cost.mjs`:

- A CDP session per recorded page, with `Page.startScreencast {format: "jpeg", quality: 70, everyNthFrame: 2, maxWidth/maxHeight: the viewport}`, acking each frame on arrival.
- Our own `spawn` of Playwright's ffmpeg (`windowsHide`) with the same VP8 arguments `recordVideo` uses, at a constant 25 fps with frame duplication.
- `--mp4` uses the system ffmpeg (x264) when it is on PATH.

**Outputs.**

- `video.webm` once, not twice.
- `transcript.txt` (action log plus marks) and `recording.json` (frame times, pointer, marks).
- `report.md` from distill.
- An mp4 is about 4.5 times smaller on app pages and plays inline in more places.

**Transcript and distill.**

- The action log already timestamps every command. Marks join it. The report wording must say "action log" for this source, not "spoken" or "speaker".
- **Phase 1:** keep distill exactly as it is on the webm (`G:\code\bx\src\daemon\harness\`), but run it off the stop path.
- **Phase 2:** cut keyframes straight from the JPEG stream at each action (the frame before and after) and at each mark, with the same 64×64 signature dedup. This drops the in-browser seek pass, and the frames are already JPEG.
- **Never** use `chromium.launch()` with Chrome for distill: its temporary profile is unseeded. Use the existing context, or the shell (which has no password code).

**Rules.**

- Never start a raw screencast while `recordVideo` or `page.screencast` is active on the same page.
- Stop the screencast before the page closes.
- A tab closed mid-recording ends that stream with a mark.

## Side findings for the lead and core

- **The `--disable-features` trap.** Chrome keeps only the last `--disable-features` switch. One added in `args` silently drops Playwright's 16 entries, including ThirdPartyStoragePartitioning, Translate, MediaRouter, HttpsUpgrades and PaintHolding. Today's args (`G:\code\bx\src\daemon\session.ts:768`) only carry the cache cap, so nothing is broken yet.
- **The `fill` timeout bug is fixed in the working tree, not in bx-live.**
  - On bx-live (a80f037), `bx fill #email` on a missing target took 35,180 ms instead of 5 s: `locator.getAttribute("type")` had no timeout and fell back to Playwright's 30 s default.
  - C4 (b29a494) now passes `{ timeout }` (`G:\code\bx\src\daemon\session.ts:1292`).
  - bx-live keeps the bug until it is promoted.
- **Click.** `locator.click` is still the path (`G:\code\bx\src\daemon\session.ts:1246`). See recommendation 4.
- **Open question: the password seed is rewritten on every launch.**
  - After each session, `os_password_last_changed` in Local State differs slightly from real Chrome's value, 13396231870399492. Examples: scout-cold-1 has 13396231870421867 and scout-rec has 13396231870087671.
  - Two profiles also gained an `is_biometric_avaliable` key.
  - So the seed logs "written" at every launch, and Chrome seems to recompute the timestamp itself.
  - I could not tell whether Chrome probes the OS password regardless. The Security log query returned no events of any kind for the last 3 hours, so it is either not readable without elevation or not being audited. That is inconclusive, not a clean bill.
  - `blank:false` held in every profile.
- **The scratch folder is session temp.** Copy any script below into the repo if it should outlive this session.

## Not measured, and why

- **A headed window on screen but fully covered, or minimized.** Testing it would take Sal's focus and desktop. Off-screen windows and background tabs did deliver frames.
- **Whether Chrome probes LogonUser despite the seed.** The Security log returned nothing readable (see above).
- **A real .NET CDP daemon's memory.** Estimated from a 4.8 MB NativeAOT idle floor.
- **`--disk-cache-size` over long runs.** The sessions were 23–26 s each.
- **Distill on a CDP-captured webm.** Only the format was checked (ffprobe: VP8 webm, the codec distill reads today).
- **The `/argv` front door end to end, and the cold-start trims end to end.** Their parts were measured separately.
- **Screencast on chrome-headless-shell.**
- **The name of the feature behind BrowserMetrics.** Disabling `PersistentHistograms` did not stop it.

## Scripts and outputs

All the files are in the session scratch folder.

**Shared helpers** (servers, process tree memory and CPU through CIM, disk usage, timing):
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\lib.mjs

**Q1 scripts:**

- Launch candidates:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\launch-bench.mjs
- The `--disable-features` override test:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\features-test.mjs
- Click and mouse costs:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\input-test.mjs
- Chrome and shell profile portability, codecs and renderer:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\shell-compat.mjs
- WebGL on GPU vs SwiftShader (the `shellgpu` argument tests the shell's ANGLE options):
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\webgl-test.mjs
- Profile growth and cache caps:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\profile-growth.mjs
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\cache-cap.mjs
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\cache-cap2.mjs

**Q1 outputs:**

C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\launch-all.json
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\launch-all.log
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\launch-shellgpu.json
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\profile-growth.json
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\cache-sizes.txt
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\smoke.json

**The shell install:**
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\browsers\chrome-headless-shell\win64-155.0.8059.39\chrome-headless-shell-win64\chrome-headless-shell.exe

**Q2 scripts:**

- Client start-up:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\cli-bench.mjs
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\cli-bench2.mjs
- Daemon `/cmd` floor and Node memory:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\http-rtt.mjs
- Minimal clients:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\clients\minimal-bun.ts
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\clients\minimal-bun.exe
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\clients\minimal-node.mjs
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\clients\minimal-node-http.mjs
- The NativeAOT client (source, project, exe):
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\aot\bxc\Program.cs
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\aot\bxc\bxc.csproj
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\aot\bxc\bin\Release\net10.0\win-x64\publish\bxc.exe
- The idle AOT server (memory floor):
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\aot\idle

**Q2 outputs:**

C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\cli-bench.json
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\cli-bench2.json

**Q3 scripts:**

- Today's flow, timed:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\rec-e2e.sh
- Screencast prototypes (file and ring, background tab, tab switch, `--headed`):
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\screencast-proto.mjs
- CPU by variant, the live encoder, and `recordVideo` with 2 tabs:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\screencast-cost.mjs
- Headed checks:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\headed-check.mjs
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\headed-cdp-bg.mjs
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\headed-frames.mjs
- The `showActions` cost:
  C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\bench\showactions-test.mjs

`headed-frames.mjs` counted Playwright's `onFrame` callbacks, so its 0 is that callback's bug, not Chrome's frame rate.

**Q3 outputs:**

C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\screencast-headless.json
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\screencast-headed.json
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\screencast-cost.json
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\rec
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\out\rec2
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\rec-e2e\recordings\t1
C:\Users\dested\AppData\Local\Temp\claude\G--code-bx\59a40366-a580-4bd0-94fc-275be2815c92\scratchpad\scout\rec-e2e\recordings\t2

The `out\rec` and `out\rec2` folders hold the webm and mp4 files. `t1` and `t2` are today's recording packages.
