// Shared contract between the bx CLI (client) and the bx daemon (server).
// Transport: localhost HTTP. POST /cmd with JSON body Cmd, auth via `x-bx-token`
// header matching the token in the run file. Responses are CmdResult<T>.
// Every module codes against these types; do not widen or bypass them.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Run file: ~/.bx/run/<profile>.json — written by the daemon on boot, deleted
// on shutdown. The CLI discovers the daemon through it.
// ---------------------------------------------------------------------------

export interface RunFile {
  profile: string;
  pid: number;
  port: number;
  token: string;
  headless: boolean;
  startedAt: string; // ISO
}

// ---------------------------------------------------------------------------
// POST /argv (token): bx.exe's front door (dotnet/bx). A whole bx command line
// in; the bytes the Bun CLI would print out. Verbs only the CLI runs (stdin,
// spawning, disk sweeps, other daemons) answer {fallback: true} and bx.exe
// runs `bun src/cli.ts` instead. 400/401/404 also mean "nothing ran".
// ---------------------------------------------------------------------------

export interface ArgvRequest {
  argv: string[]; // process argv after the exe, unrepaired (MSYS repair runs daemon-side)
  cwd: string; // the caller's working directory; relative paths resolve against it
  pid?: number; // for the client tag
  // Only these are read; anything else is ignored.
  env: { BX_TIMING?: string; MSYSTEM?: string; EXEPATH?: string; CLAUDE_CODE_SESSION_ID?: string };
}

export type ArgvResponse = { stdout: string; stderr: string; exit: number } | { fallback: true };

// Directory names, the client and deadline headers live in constants.ts (no
// zod there, so the CLI's hot path can load them cheaply).
export {
  BX_DIR_NAME,
  CLIENT_HEADER,
  DEADLINE_HEADER,
  DEFAULT_DEADLINE_MS,
  LOGS_DIR,
  PROFILES_DIR,
  RUN_DIR,
  SNAPS_DIR,
} from "./constants.ts";

// ---------------------------------------------------------------------------
// Targets. CLI parsing: `@12` → ref; bare digits → {ref, orText}; prefixes
// `text:`, `testid:`, `label:`, `role:<role>[:<name>]` → that variant; starts
// with '#', '.', '[', '//', 'css=', 'xpath=' → selector; otherwise → text.
// `--exact` sets exact, `--first` sets first on the parsed target.
//
// Resolution (src/daemon/resolve.ts) scores every visible candidate in one
// in-page pass: exact accessible name > exact text > prefix > substring;
// inside an open dialog or the viewport beats elsewhere; hidden elements never
// match. exact:true drops prefix/substring matches. A tie at the top score is
// `ambiguous` (nearMatches lists the tied candidates as refs) unless first:true,
// which takes the first in document order. Text candidates: test ids, roles
// (button, link, tab, menuitem, checkbox, radio, option, switch, combobox),
// labels, placeholders, then any element's own text.
// ---------------------------------------------------------------------------

const matchOpts = {
  exact: z.boolean().optional(),
  first: z.boolean().optional(),
};

export const TargetSchema = z.union([
  // orText: the CLI sends bare digits ("2") as {ref: 2, orText: "2"} — the
  // daemon uses the ref only when it exists in the page's current registry,
  // otherwise resolves orText as a text target. `@2` is always a ref.
  z.object({ ref: z.number().int().positive(), orText: z.string().min(1).optional() }),
  z.object({ testid: z.string().min(1), ...matchOpts }),
  z.object({ role: z.string().min(1), name: z.string().optional(), ...matchOpts }),
  z.object({ label: z.string().min(1), ...matchOpts }),
  z.object({ text: z.string().min(1), ...matchOpts }),
  z.object({ selector: z.string().min(1) }),
]);
export type Target = z.infer<typeof TargetSchema>;

// A distilled interactive element, as shown by `bx els`.
export interface El {
  ref: number;
  tag: string; // 'button' | 'a' | 'input' | ... (lowercase tag or aria role)
  role: string; // computed role best-effort: button/link/textbox/checkbox/...
  name: string; // accessible name approximation, trimmed, max 80 chars
  state: string[]; // subset of: disabled, checked, selected, expanded, focused
  testid?: string; // data-testid when present
  id?: string; // element id when present
  frame?: string; // set for elements inside a same-origin iframe: the frame's name or src
  dialog?: boolean; // inside the open modal/dialog (listed first)
}

// Refs (daemon/resolve.ts): each page's `window.__bx` maps ref → WeakRef(element), so a
// ref names the element itself and survives re-scans. A ref goes stale only when its
// element leaves the page (or its document is replaced); numbers are never reused
// within a tab.

// ---------------------------------------------------------------------------
// Output budgets (characters; ~4 chars/token). Enforced daemon-side so no
// caller can accidentally flood a model context.
// ---------------------------------------------------------------------------

export const BUDGET = {
  ELS_MAX_ELEMENTS: 100,
  ELS_MAX_CHARS: 3200, // ~800 tokens
  TEXT_MAX_CHARS: 8000, // ~2000 tokens
  JS_MAX_CHARS: 4000,
  CONSOLE_MAX_ENTRIES: 30,
  NET_MAX_ENTRIES: 30,
  RING_BUFFER_SIZE: 500,
  SNAP_MAX_WIDTH: 1024, // downscale screenshots to this width
  DEFAULT_TIMEOUT_MS: 5000,
} as const;

// ---------------------------------------------------------------------------
// Commands. Discriminated on `cmd`. One zod schema validates the whole union
// at the daemon boundary.
// ---------------------------------------------------------------------------

// Optional tab pinning: `tab` is a stable per-page id (assigned at page
// creation, never reused). A command carrying `tab` acts on that page
// regardless of which tab is active; without it, the active tab is used —
// the human CLI never sets it. This is the concurrency contract: each
// concurrent driver (e.g. every `bx agent` run) works in its own pinned tab,
// so parallel agents cannot yank pages out from under each other. A pinned
// command whose tab has been closed fails with code "no_page".
const tabPin = { tab: z.number().int().nonnegative().optional() };

// Adaptive settle for actions: after the action the daemon waits until the DOM
// and the action's network requests are quiet for 50 ms, capped at `settle` ms
// (default 1000; 0 skips settling). ActionResult.settledMs reports the wait.
//
// then: append an observation to the same result (ActionResult.then).
// until: after settling, wait for this text to be visible (timeoutMs applies);
// the action fails with `timeout` when it never shows.
const actionOpts = {
  settle: z.number().int().nonnegative().optional(),
  then: z.enum(["els", "text", "snap"]).optional(),
  until: z.string().min(1).optional(),
};

export const CmdSchema = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("open"), url: z.string(), ...tabPin }),
  z.object({
    cmd: z.literal("els"),
    all: z.boolean().optional(),
    filter: z.string().optional(),
    diff: z.boolean().optional(), // only what changed since this tab's last scan (ElsResult.diff)
    clickables: z.boolean().optional(), // also list cursor:pointer elements with no role
    ...tabPin,
  }),
  z.object({
    cmd: z.literal("click"),
    target: TargetSchema,
    timeoutMs: z.number().optional(),
    ...actionOpts,
    ...tabPin,
  }),
  z.object({
    cmd: z.literal("fill"),
    target: TargetSchema,
    value: z.string(),
    timeoutMs: z.number().optional(),
    ...actionOpts,
    ...tabPin,
  }),
  z.object({ cmd: z.literal("press"), key: z.string(), ...actionOpts, ...tabPin }), // e.g. "Enter", "Control+a"
  z.object({
    cmd: z.literal("select"),
    target: TargetSchema,
    value: z.string(), // option value or label
    timeoutMs: z.number().optional(),
    ...actionOpts,
    ...tabPin,
  }),
  z.object({
    cmd: z.literal("wait"),
    // exactly one of:
    text: z.string().optional(), // wait until text visible
    selector: z.string().optional(), // wait until selector visible
    ms: z.number().optional(), // plain sleep
    idle: z.boolean().optional(), // network and DOM quiet for 500 ms
    gone: TargetSchema.optional(), // wait until this target is no longer visible
    url: z.string().optional(), // wait until the URL contains this
    js: z.string().optional(), // wait until this expression is truthy
    timeoutMs: z.number().optional(),
    ...tabPin,
  }),
  z.object({
    cmd: z.literal("expect"),
    kind: z.enum(["text", "url", "visible", "notVisible"]),
    value: z.string(), // text content, url substring, or target text/selector
    timeoutMs: z.number().optional(),
    ...tabPin,
  }),
  z.object({
    cmd: z.literal("snap"),
    path: z.string().optional(),
    full: z.boolean().optional(),
    target: TargetSchema.optional(), // crop to this element
    jpeg: z.boolean().optional(),
    quality: z.number().int().min(1).max(100).optional(), // jpeg only, default 80
    stable: z.boolean().optional(), // wait until two consecutive frames match (cap 3 s)
    ...tabPin,
  }),
  z.object({
    cmd: z.literal("text"),
    selector: z.string().optional(), // legacy; target wins when both are set
    target: TargetSchema.optional(), // no target: main/[role=main] if present, else body
    md: z.boolean().optional(), // headings, lists and links as compact markdown
    timeoutMs: z.number().optional(),
    ...tabPin,
  }),
  z.object({
    cmd: z.literal("console"),
    all: z.boolean().optional(), // default: errors + warnings only
    filter: z.string().optional(), // regex source; an invalid regex matches as plain text
    allTabs: z.boolean().optional(), // a pinned command sees only its tab unless set
    ...tabPin,
  }),
  z.object({
    cmd: z.literal("net"),
    failed: z.boolean().optional(), // only status >= 400 / aborted
    filter: z.string().optional(), // regex source matched against url; invalid → plain text
    all: z.boolean().optional(), // every resource type; default xhr, fetch and document
    allTabs: z.boolean().optional(),
    ...tabPin,
  }),
  // Response body of one NetEntry (by id), fetched on demand while the page
  // that made it is still open. Text bodies only; capped at TEXT_MAX_CHARS.
  z.object({ cmd: z.literal("netBody"), id: z.number().int().nonnegative() }),
  z.object({ cmd: z.literal("js"), expression: z.string(), ...tabPin }),
  // Install an in-page controller and poll a predicate — entirely daemon-side,
  // zero model turns while it runs. THE primitive for driving real-time games:
  // `install` runs once (statements; e.g. set the app's per-frame input hook),
  // then `until` is evaluated every pollMs until truthy or timeoutMs elapses.
  // Re-issuing drive replaces the controller (install just runs again) — the
  // cheap-iteration loop for tuning a controller without restarting the game.
  z.object({
    cmd: z.literal("drive"),
    install: z.string(), // JS statements, evaluated once before polling
    until: z.string(), // JS expression; truthy ends the poll with satisfied=true
    timeoutMs: z.number().int().positive().optional(), // default 15000
    pollMs: z.number().int().positive().optional(), // default 500
    ...tabPin,
  }),
  z.object({ cmd: z.literal("back"), ...actionOpts, ...tabPin }),
  z.object({ cmd: z.literal("reload"), ...actionOpts, ...tabPin }),
  // Coordinate interaction (canvas/games/non-semantic UIs). x/y are CSS
  // pixels. With `in`, coordinates are relative to that element's top-left
  // (resolution-independent for a fixed-size canvas); without it, viewport
  // coordinates. All log to the action log and synthesize into flows.
  z.object({
    cmd: z.literal("mouse"),
    action: z.enum(["click", "dblclick", "move", "down", "up"]),
    x: z.number(),
    y: z.number(),
    in: TargetSchema.optional(),
    button: z.enum(["left", "right", "middle"]).optional(), // default left
    ...actionOpts,
    ...tabPin,
  }),
  z.object({
    cmd: z.literal("drag"),
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
    in: TargetSchema.optional(),
    steps: z.number().int().positive().optional(), // intermediate move count, default 10 (pointer: 20)
    // "mouse" (default) = Playwright mouse.*; "pointer" = synthetic
    // pointerdown/move/up with a pointerId, for touch-none / pointer-intent
    // DnD that never sees mouse events. Pointer mode delivers move/up to the
    // pointerdown target (setPointerCapture semantics).
    mode: z.enum(["mouse", "pointer"]).optional(),
    holdMs: z.number().nonnegative().optional(), // pause after down before first move (pointer default 120)
    stepDelayMs: z.number().nonnegative().optional(), // pause between moves (pointer default 16)
    ...actionOpts,
    ...tabPin,
  }),
  // Hold-and-release keys (WASD movement etc.): `key down w` … `key up w`.
  // One-shot chords stay on `press`.
  z.object({ cmd: z.literal("key"), action: z.enum(["down", "up"]), key: z.string(), ...actionOpts, ...tabPin }),
  z.object({
    cmd: z.literal("wheel"),
    deltaY: z.number(),
    // move the mouse here first; with `in`, element-relative. `in` with
    // neither x nor y scrolls that element into view (then wheels deltaY if ≠ 0).
    x: z.number().optional(),
    y: z.number().optional(),
    in: TargetSchema.optional(),
    ...actionOpts,
    ...tabPin,
  }),
  z.object({ cmd: z.literal("tabs") }),
  // background: create without stealing the active tab or focus — the pin
  // path for agents; a human's unpinned commands must never be redirected
  // into a tab an agent just made.
  z.object({ cmd: z.literal("tabNew"), url: z.string().optional(), background: z.boolean().optional() }),
  z.object({ cmd: z.literal("tabSelect"), index: z.number().int().nonnegative() }),
  // scope omitted: close the pinned/active tab (the original behavior).
  // "others": close every tab but the active one. "all": close every tab,
  // leaving a single blank tab so the context (and daemon) stays alive.
  z.object({ cmd: z.literal("tabClose"), scope: z.enum(["others", "all"]).optional(), ...tabPin }),
  // Recording (V1): one tab over CDP Page.startScreencast piped into ffmpeg. No
  // context relaunch: tabs, typed values and page ids survive start and stop.
  // tab: record that tab (default: the active one). follow: re-target whenever
  // the active tab changes (tab select / popup activation). ring: keep only the
  // newest <ring> seconds (cap 600) in memory; `recordSave` clips from it and
  // `recordStop` packages whatever the ring holds. fps: screencast pacing
  // (default 30; output is constant 25 fps webm, frames duplicated as needed).
  z.object({
    cmd: z.literal("recordStart"),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    tab: z.number().int().positive().optional(),
    follow: z.boolean().optional(),
    ring: z.number().int().min(5).max(600).optional(),
    fps: z.union([z.literal(30), z.literal(60)]).optional(),
  }),
  // outDir: absolute dir for the package. Returns as soon as video, transcript
  // and recording.json are written; distill (report.md) runs in the background
  // unless `distill` is true, in which case stop waits for it. mp4: also write
  // video.mp4 (system ffmpeg with x264; error `bad_request` when unavailable).
  z.object({
    cmd: z.literal("recordStop"),
    outDir: z.string(),
    distill: z.boolean().optional(),
    mp4: z.boolean().optional(),
  }),
  // A chapter marker in the action log (and the report). Requires a recording.
  z.object({ cmd: z.literal("recordMark"), text: z.string().min(1).max(200) }),
  // Ring mode only: encode the newest `lastSecs` seconds into a package at
  // outDir while capture continues. Error `not_recording` without a ring.
  z.object({
    cmd: z.literal("recordSave"),
    lastSecs: z.number().int().min(1).max(600),
    outDir: z.string(),
    mp4: z.boolean().optional(),
  }),
  z.object({ cmd: z.literal("recordStatus") }),
  // Re-run distill on an existing package dir (writes report.md).
  z.object({ cmd: z.literal("recordDistill"), dir: z.string() }),
  z.object({ cmd: z.literal("status") }),
  z.object({ cmd: z.literal("actionLog"), sinceIndex: z.number().int().nonnegative().optional() }),
]);
export type Cmd = z.infer<typeof CmdSchema>;
export type CmdName = Cmd["cmd"];

// ---------------------------------------------------------------------------
// Results. data shape per command below. Errors carry a machine-usable code
// plus a human message; `nearMatches` powers self-repair (closest visible
// elements when a target fails to resolve).
// ---------------------------------------------------------------------------

// relaunched: the daemon found the browser dead and relaunched it (same
// profile and mode, one blank tab) before running this command.
export type CmdResult<T = unknown> =
  | { ok: true; data: T; relaunched?: true }
  | { ok: false; error: BxError };

export interface BxError {
  code:
    | "target_not_found"
    | "stale_ref"
    | "timeout"
    | "no_page"
    | "not_recording"
    | "already_recording"
    | "browser_launch_failed"
    | "browser_dead" // relaunch failed twice in a row
    | "deadline" // the command outran its deadline (DEADLINE_HEADER)
    | "ambiguous" // several equally good matches; nearMatches lists them
    | "bad_request"
    | "internal";
  message: string;
  nearMatches?: El[]; // for target_not_found: up to 5 candidates
}

export interface PageInfo {
  index: number;
  /** Stable per-page id for tab pinning — assigned at creation, never reused. */
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export interface OpenResult {
  page: PageInfo;
  els: ElsResult;
  redirectedTo?: string; // final URL when the page redirected itself after load
}
export interface ElsResult {
  generation: number; // this tab's scan count (refs no longer expire per scan)
  els: El[];
  total: number; // total interactive found (may exceed els.length)
  truncated: boolean;
  rendered: string; // preformatted lines: `[3] button "Save changes"` — print as-is
  // els --diff: changes since this tab's previous scan (els/rendered then hold
  // only added + changed). Absent on a full scan.
  diff?: { added: number; removed: number[]; changed: number };
}

// What an action changed, measured across the action and its settle.
export interface ActionDelta {
  url?: string; // new URL when it changed
  title?: string; // new title when it changed
  dialog?: "opened" | "closed"; // a modal/dialog appeared or went away
  alerts?: string[]; // new role=alert/status/toast text, max 3, 200 chars each
  added: number; // element nodes added to the DOM
  removed: number; // element nodes removed
  focused?: string; // the focused element afterwards, as `role "name"`
  newTab?: PageInfo; // a popup/tab this action opened; active when the acting tab was active (O2)
}
export interface ActionResult {
  // returned by click/fill/press/select/mouse/drag/key/wheel/back/reload/wait
  page: PageInfo;
  navigated: boolean; // url changed as a result of the action
  consoleErrors: string[]; // NEW console errors emitted during the action (max 5)
  settledMs: number; // adaptive settle wait after the action (0 when skipped)
  delta?: ActionDelta;
  then?: { els?: ElsResult; text?: TextResult; snap?: SnapResult }; // per the action's `then`
}
export interface ExpectResult { pass: boolean; detail: string }
export interface SnapResult {
  path: string;
  width: number; // of the saved image
  height: number; // of the saved image (full-page height for --full)
  bytes: number;
  format?: "png" | "jpeg";
}
export interface TextResult { text: string; truncated: boolean }
export interface ConsoleEntry {
  t: number; // ms since daemon start
  tab?: number; // stable page id that logged it
  level: "log" | "info" | "warn" | "error" | "pageerror";
  text: string; // capped 400 chars
  url: string; // page url at time of entry
}
export interface NetEntry {
  id?: number; // for netBody
  tab?: number; // stable page id that made the request
  resourceType?: string; // document, xhr, fetch, script, image, …
  t: number;
  method: string;
  url: string; // capped 200 chars
  status: number; // 0 = failed/aborted
  ms: number; // duration
  failed: boolean;
}
export interface JsResult { value: string; truncated: boolean } // always valid JSON
export interface NetBodyResult {
  id: number;
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}
export interface DriveResult {
  satisfied: boolean; // until became truthy before the timeout
  elapsedMs: number;
  polls: number; // until evaluations performed
  // JSON.stringify of the last `until` evaluation (capped at BUDGET.JS_MAX_CHARS);
  // when every poll threw, the last error message instead.
  finalValue: string;
  page: PageInfo;
}
// created: set by tabNew — the page it made
export interface TabsResult { pages: PageInfo[]; created?: PageInfo }
export interface RecordStartResult {
  slug: string;
  tab: number; // the tab being captured
  ring?: number; // seconds kept, in ring mode
  firstFrameMs: number; // start → first frame (start fails with `internal` past 1000)
}
export interface RecordStopResult {
  dir: string; // recordings/<slug>/
  videoPath: string; // <dir>/video.webm (written once)
  mp4Path?: string; // <dir>/video.mp4 when asked for
  transcriptPath: string; // <dir>/transcript.txt: action log + marks, timestamped
  metaPath: string; // <dir>/recording.json: frame times, tabs, marks
  reportPath: string; // <dir>/report.md, present once distill has run
  distill: "done" | "running" | "failed"; // "running": it finishes in the background
  durationMs: number;
  frames: number;
  actionCount: number;
}
export interface RecordStatusResult {
  recording: boolean;
  slug?: string;
  tab?: number;
  follow?: boolean;
  ring?: number; // seconds kept (ring mode)
  elapsedMs?: number;
  frames?: number;
  bufferedBytes?: number; // ring mode: bytes held
  marks?: number;
  distilling: string[]; // package dirs whose background distill is still running
}
export interface StatusResult {
  profile: string;
  headless: boolean;
  browserRunning: boolean;
  pages: PageInfo[];
  recording: string | null; // slug when recording
  uptimeMs: number;
  relaunches: number; // browser relaunches since daemon start (self-heal)
}

// Action log: appended for every state-changing command (open, click, fill,
// press, select, mouse, drag, key, wheel, drive, back, reload, tabNew,
// tabSelect, tabClose, js — flows replay js steps, which may set state) and for every
// PASSING expect (failing expects are exploration noise and are not logged).
// Used for flow synthesis and as the recording "transcript" — passing expects
// are what turn a synthesized flow into a regression test instead of a list
// of opens. The `tab` pin field is stripped from cmdJson before logging:
// synthesized flows replay single-tab in a fresh session.
export interface ActionLogEntry {
  index: number;
  t: number; // ms since daemon start
  cmd: CmdName;
  // Human sentence used as transcript text, e.g. `clicked "Save changes"`,
  // `filled "Email" with "me@x.com"`, `opened https://…`. Redact fill values
  // for inputs whose type=password: `filled "Password" with "•••"`.
  text: string;
  // Machine form for flow synthesis: the original Cmd minus volatile bits.
  cmdJson: string;
  // Replay-stable target recorded at resolution time: the element's testid if
  // present, else its accessible name, else the original selector. Refs never
  // appear here — synthesized flows must survive a fresh session.
  stableTarget?: string;
  // Stable page id the command acted on. This is what lets a concurrent
  // consumer (an agent run's fail-report evidence, its flow synthesis) keep
  // only its own tab's actions out of the shared log. Absent only for
  // commands with no page (e.g. tabSelect before any page exists).
  tab?: number;
}
export interface ActionLogResult { entries: ActionLogEntry[]; nextIndex: number }

// ---------------------------------------------------------------------------
// Agent driver (src/agent/driver.ts) public surface — used by the CLI.
// ---------------------------------------------------------------------------

export type AgentModel = "haiku" | "sonnet" | "opus";

export interface AgentRunOptions {
  instruction: string;
  profile: string;
  model: AgentModel; // starting tier; may escalate haiku → sonnet once
  save?: string; // flow name: synthesize flows/<save>.flow.ts on success
  /** per-attempt turn budget; default 40. CLI: --max-turns. */
  maxTurns?: number;
  /** stream each tool call/result to stderr as it happens. CLI: --verbose. */
  verbose?: boolean;
  /** allow a FINAL escalation sonnet → Opus 5.5. Opt-in only (CLI: --opus);
   * for complex flows — ~2× Sonnet cost. Never escalates past the tier the
   * user started at: --model opus runs Opus directly with no chain. */
  escalateOpus?: boolean;
  /** bx_snap returns the screenshot itself (JPEG q70, ≤1024 wide, optional
   * element crop) instead of a path. Off by default: images cost tokens.
   * For canvas/game pages where the DOM has nothing to read. CLI: --vision. */
  vision?: boolean;
  /** estimated-spend ceiling in USD across ALL rungs; the run aborts mid-rung
   * when the estimate crosses it and still emits a synthesized fail report.
   * Estimate = per-tier token pricing, cache reads billed at 10% of input.
   * CLI: --budget <usd>. */
  budgetUsd?: number;
  /** wall-clock ceiling in ms across all rungs; same abort semantics.
   * CLI: --max-wall <s>. */
  maxWallMs?: number;
  /** stall detection: when the last `stallWindow` tool calls contain ≤3
   * distinct (tool, input) pairs, the rung ends early (escalation can then
   * fire without burning the full turn budget). Default window 8; 0 disables.
   * Not a CLI flag — a tuning knob. */
  stallWindow?: number;
  /** print a one-line heartbeat (turn · est cost · last action) to stdout
   * every N turns even without --verbose. Default 10; 0 disables. */
  heartbeatTurns?: number;
  /** open the run's pinned tab here before the model's first turn instead of
   * about:blank. Required by --enter (the setup JS needs a loaded page).
   * CLI: --url. */
  startUrl?: string;
  /** entry recipe: JS statements evaluated in the pinned tab BEFORE the model's
   * first turn (and re-run on each escalation rung's fresh tab — in-page state
   * does not survive a new tab). Kills the entry-discovery cost sink: e.g.
   * "window.__studio.getState().openProject('id'); window.__studio.getState().setPlaying(true)".
   * Requires startUrl. CLI: --enter <js>. */
  enterJs?: string;
  /** success predicate: JS expression that is truthy exactly when the task is
   * done. Handed to the model to poll via bx_js, AND verified by the driver
   * when the model reports pass — a pass whose predicate evaluates falsy is
   * flipped to fail. CLI: --win <js-expr>. */
  winExpr?: string;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null; // the SDK's own figure (its bundled price table), else null
}

export interface AgentReport {
  status: "pass" | "fail";
  summary: string; // one paragraph, model-authored
  evidence: string[]; // e.g. "expect text 'Saved' passed", snap paths
  tier: AgentModel; // tier that produced the final result
  escalated: boolean;
  turns: number;
  wallMs: number;
  usage: AgentUsage; // summed across tiers
  savedFlow?: string; // path of synthesized flow file
  /** full turn-by-turn transcript, always written: ~/.bx/agent-runs/<ts>.jsonl */
  transcriptPath?: string;
  /** how the final rung ended. "report" is the only healthy value. */
  endedBy?: "report" | "turns" | "stall" | "budget" | "wall" | "error";
  /** the cost estimate the budget cap runs on: src/agent/pricing.ts applied to
   * each rung's metered token totals (rebased at every rung boundary). The
   * number to quote. `usage.costUsd` is the SDK's own figure from its bundled
   * price table, which can predate the pinned models (0.3.221 bills Haiku 5.5
   * at $5/$25). On aborted runs estUsd also includes the aborted rung's spend,
   * which `usage.costUsd` structurally cannot (its result never arrives). */
  estUsd?: number;
}

// ---------------------------------------------------------------------------
// HTTP surface
//   GET  /health                → { ok: true, profile, browserRunning }
//   POST /cmd                   → CmdResult (body: Cmd, header x-bx-token)
//   POST /shutdown              → closes browser, deletes run file, exits
//   GET  /fixture/*             → serves fixtures/app/* (test app, no auth)
//   GET  /harness               → video-to-prompt harness page (no auth; localhost only)
//   GET  /harness.js            → prebuilt bundle
//   GET  /harness/video         → the webm being distilled
//   GET  /harness/meta          → { title, segments: [{t, text}] } (action log as transcript)
//   POST /harness/result        → { path, base64 } one file written under the package dir
//   POST /harness/done          → harness signals the distill finished
//   POST /harness/error         → { message } harness signals the distill failed
//   GET  /debug, POST /debug/gc, POST /debug/heapsnapshot → see "Debug surface"
// ---------------------------------------------------------------------------

export interface HealthResult { ok: true; profile: string; browserRunning: boolean }

// ---------------------------------------------------------------------------
// Debug surface, for monitors outside bx (destedtui's `bx` screen). All three
// need the x-bx-token header and answer with a CmdResult envelope.
//   GET  /debug               → DebugResult
//   GET  /debug?light=1       → the same, every pages[].metrics null: no per-page CDP work
//   POST /debug/gc            → DebugGcResult (daemons are spawned with --expose-gc)
//   POST /debug/heapsnapshot  → DebugHeapSnapshotResult (stalls the daemon for seconds)
// Reading /debug never counts as activity: a monitor left open must not keep
// an idle daemon from exiting. Monitors parse this with their own schema, so
// changes are additive only: add fields, never rename or retype one.
// ---------------------------------------------------------------------------

export const DEBUG_VERSION = 1;
export const HEAPS_DIR = "heaps"; // ~/.bx/heaps/<profile>-<ts>.heapsnapshot

// Who sent a /cmd. The CLI tags every request so a monitor can say which
// Claude session (or terminal) is driving which daemon. Sent as
// encodeURIComponent(JSON.stringify(tag)); a missing or bad tag is ignored.
export const ClientTagSchema = z.object({
  session: z.string().optional(), // the caller's CLAUDE_CODE_SESSION_ID
  cwd: z.string().optional(),
  pid: z.number().int().optional(),
  via: z.string().optional(), // the bx verb that sent it: "click", "agent", "run"…
});
export type ClientTag = z.infer<typeof ClientTagSchema>;

export interface DebugCmd {
  id: number; // monotonic per daemon
  cmd: CmdName;
  summary: string; // `click "Save"`, `open https://…`; fill/select values never appear
  tab?: number;
  client?: string; // DebugClient.key
  startedAt: number; // epoch ms
}
export interface DebugCmdDone extends DebugCmd {
  ms: number;
  ok: boolean;
  error?: string; // "<code>: <message>", truncated
}
export interface DebugClient {
  key: string; // the session id, else the cwd, else "anonymous"
  session?: string;
  cwd?: string;
  pid?: number; // the most recent sender's pid
  via?: string; // the most recent verb
  firstSeen: number;
  lastSeen: number;
  commands: number;
}
// Chrome's own counters for a page (CDP Performance.getMetrics).
export interface DebugPageMetrics {
  jsHeapUsed: number;
  jsHeapTotal: number;
  nodes: number;
  documents: number;
  listeners: number;
  frames: number;
  layoutCount: number;
  scriptMs: number; // cumulative
  taskMs: number; // cumulative
}
export interface DebugPage {
  tab: number;
  url: string;
  title: string;
  active: boolean;
  metrics: DebugPageMetrics | null; // null: the page didn't answer in time (busy, navigating)
  refs: number; // this page's ref registry size
}
export interface DebugResult {
  v: number; // DEBUG_VERSION
  profile: string;
  pid: number;
  headless: boolean;
  startedAt: number; // epoch ms
  uptimeMs: number;
  node: {
    version: string;
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    cpuUserMs: number; // cumulative: diff two reads for a rate
    cpuSystemMs: number;
    loopDelayMs: { mean: number; p99: number; max: number }; // since the previous /debug read
    gcExposed: boolean;
  };
  browserRunning: boolean;
  recording: string | null;
  idle: { lastActivityAt: number; limitMs: number }; // limitMs 0 = never exits on idle
  inFlight: DebugCmd[];
  recent: DebugCmdDone[]; // newest last, capped
  totals: {
    commands: number;
    errors: number;
    byCmd: Record<string, { n: number; errors: number; ms: number }>;
  };
  clients: DebugClient[];
  internals: {
    actionLog: number; // entries kept; the newest actionLogCap survive (daemon/actionLog.ts)
    actionLogChars: number;
    actionLogDropped: number; // trimmed over the daemon's life
    actionLogCap: number;
    refPages: number;
    refEntries: number;
    consolePushed: number; // lifetime pushes into the console ring
    netPushed: number;
    ringCap: number;
  };
  pages: DebugPage[];
}
export interface DebugGcResult { ran: boolean; heapBefore: number; heapAfter: number }
export interface DebugHeapSnapshotResult { path: string; bytes: number; ms: number }

// Exit codes used by the CLI: 0 success, 1 command/expect failure, 2 usage
// error, 3 daemon/browser failure.
