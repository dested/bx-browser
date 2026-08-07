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

export const BX_DIR_NAME = ".bx"; // under os.homedir()
export const RUN_DIR = "run"; // ~/.bx/run/<profile>.json
export const PROFILES_DIR = "profiles"; // ~/.bx/profiles/<name> (chrome user-data-dir)
export const SNAPS_DIR = "snaps"; // ~/.bx/snaps/<ts>.png
export const LOGS_DIR = "logs"; // ~/.bx/logs/<profile>.log (daemon stdout/stderr)

// ---------------------------------------------------------------------------
// Targets. CLI parsing rule: /^\d+$/ → ref; starts with '#', '.', '[', '//',
// 'css=', 'xpath=' → selector; otherwise → text.
// Text resolution order (first match wins, must be visible):
//   1. [data-testid="<text>"]
//   2. getByRole('button'|'link'|'tab'|'menuitem'|'checkbox'|'radio', {name, exact:false})
//   3. getByLabel(text)  4. getByPlaceholder(text)
//   5. getByText(text, {exact:true})  6. getByText(text) first visible match
// ---------------------------------------------------------------------------

export const TargetSchema = z.union([
  z.object({ ref: z.number().int().positive() }),
  z.object({ text: z.string().min(1) }),
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
}

// Ref registry entry stored daemon-side. generation increments on every els
// scan and every navigation; a ref from an older generation errors with
// "stale ref — re-run els".
export interface RefEntry {
  ref: number;
  generation: number;
  // Resolution strategies, tried in order.
  testid?: string;
  domId?: string;
  role?: { role: string; name: string };
  cssPath: string; // nth-child chain fallback, always present
}

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

export const CmdSchema = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("open"), url: z.string() }),
  z.object({
    cmd: z.literal("els"),
    all: z.boolean().optional(),
    filter: z.string().optional(),
  }),
  z.object({ cmd: z.literal("click"), target: TargetSchema, timeoutMs: z.number().optional() }),
  z.object({
    cmd: z.literal("fill"),
    target: TargetSchema,
    value: z.string(),
    timeoutMs: z.number().optional(),
  }),
  z.object({ cmd: z.literal("press"), key: z.string() }), // e.g. "Enter", "Control+a"
  z.object({
    cmd: z.literal("select"),
    target: TargetSchema,
    value: z.string(), // option value or label
    timeoutMs: z.number().optional(),
  }),
  z.object({
    cmd: z.literal("wait"),
    // exactly one of:
    text: z.string().optional(), // wait until text visible
    selector: z.string().optional(), // wait until selector visible
    ms: z.number().optional(), // plain sleep
    timeoutMs: z.number().optional(),
  }),
  z.object({
    cmd: z.literal("expect"),
    kind: z.enum(["text", "url", "visible", "notVisible"]),
    value: z.string(), // text content, url substring, or target text/selector
    timeoutMs: z.number().optional(),
  }),
  z.object({ cmd: z.literal("snap"), path: z.string().optional(), full: z.boolean().optional() }),
  z.object({ cmd: z.literal("text"), selector: z.string().optional() }),
  z.object({
    cmd: z.literal("console"),
    all: z.boolean().optional(), // default: errors + warnings only
    filter: z.string().optional(), // regex source
  }),
  z.object({
    cmd: z.literal("net"),
    failed: z.boolean().optional(), // only status >= 400 / aborted
    filter: z.string().optional(), // regex source matched against url
  }),
  z.object({ cmd: z.literal("js"), expression: z.string() }),
  z.object({ cmd: z.literal("back") }),
  z.object({ cmd: z.literal("reload") }),
  z.object({ cmd: z.literal("tabs") }),
  z.object({ cmd: z.literal("tabNew"), url: z.string().optional() }),
  z.object({ cmd: z.literal("tabSelect"), index: z.number().int().nonnegative() }),
  z.object({ cmd: z.literal("tabClose") }),
  z.object({ cmd: z.literal("recordStart"), slug: z.string().regex(/^[a-z0-9-]+$/) }),
  z.object({ cmd: z.literal("recordStop"), outDir: z.string() }), // absolute dir for the package
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

export type CmdResult<T = unknown> =
  | { ok: true; data: T }
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
    | "bad_request"
    | "internal";
  message: string;
  nearMatches?: El[]; // for target_not_found: up to 5 candidates
}

export interface PageInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface OpenResult { page: PageInfo; els: ElsResult }
export interface ElsResult {
  generation: number;
  els: El[];
  total: number; // total interactive found (may exceed els.length)
  truncated: boolean;
  rendered: string; // preformatted lines: `[3] button "Save changes"` — print as-is
}
export interface ActionResult {
  // returned by click/fill/press/select/back/reload/wait/open-less commands
  page: PageInfo;
  navigated: boolean; // url changed as a result of the action
  consoleErrors: string[]; // NEW console errors emitted during the action (max 5)
}
export interface ExpectResult { pass: boolean; detail: string }
export interface SnapResult { path: string; width: number; height: number; bytes: number }
export interface TextResult { text: string; truncated: boolean }
export interface ConsoleEntry {
  t: number; // ms since daemon start
  level: "log" | "info" | "warn" | "error" | "pageerror";
  text: string; // capped 400 chars
  url: string; // page url at time of entry
}
export interface NetEntry {
  t: number;
  method: string;
  url: string; // capped 200 chars
  status: number; // 0 = failed/aborted
  ms: number; // duration
  failed: boolean;
}
export interface JsResult { value: string; truncated: boolean } // JSON.stringify'd
export interface TabsResult { pages: PageInfo[] }
export interface RecordStartResult { slug: string }
export interface RecordStopResult {
  dir: string; // recordings/<slug>/
  reportPath: string; // <dir>/report.md
  videoPath: string; // raw webm kept alongside
  actionCount: number;
}
export interface StatusResult {
  profile: string;
  headless: boolean;
  browserRunning: boolean;
  pages: PageInfo[];
  recording: string | null; // slug when recording
  uptimeMs: number;
}

// Action log: appended for every state-changing command (open, click, fill,
// press, select, back, reload, tabNew, tabSelect, tabClose). Used for flow
// synthesis and as the recording "transcript".
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
}
export interface ActionLogResult { entries: ActionLogEntry[]; nextIndex: number }

// ---------------------------------------------------------------------------
// Agent driver (src/agent/driver.ts) public surface — used by the CLI.
// ---------------------------------------------------------------------------

export type AgentModel = "haiku" | "sonnet";

export interface AgentRunOptions {
  instruction: string;
  profile: string;
  model: AgentModel; // starting tier; may escalate haiku → sonnet once
  save?: string; // flow name: synthesize flows/<save>.flow.ts on success
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null; // when the SDK reports it, else null
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
//   POST /harness/result        → { files: [{ path, base64 }] } written under the package dir
// ---------------------------------------------------------------------------

export interface HealthResult { ok: true; profile: string; browserRunning: boolean }

// Exit codes used by the CLI: 0 success, 1 command/expect failure, 2 usage
// error, 3 daemon/browser failure.
