// The daemon's debug surface: a journal of every /cmd (in flight, recent,
// totals, who sent it) plus the process and page counters a monitor needs to
// spot a leak. Served at GET /debug; see "Debug surface" in protocol.ts.
//
// Node runtime (like the rest of src/daemon): node:* only, no Bun.*.

import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { writeHeapSnapshot } from "node:v8";
import {
  BX_DIR_NAME,
  ClientTagSchema,
  DEBUG_VERSION,
  HEAPS_DIR,
  type BxError,
  type ClientTag,
  type Cmd,
  type DebugClient,
  type DebugCmd,
  type DebugCmdDone,
  type DebugGcResult,
  type DebugHeapSnapshotResult,
  type DebugResult,
  type Target,
} from "../protocol.ts";
import type { Session } from "./session.ts";

const RECENT_CAP = 200;
const CLIENTS_CAP = 50;
const SUMMARY_CAP = 120;
const ERROR_CAP = 200;

function oneLine(s: string, cap = SUMMARY_CAP): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`;
}

function targetText(t: Target): string {
  if ("ref" in t) return `[${t.ref}]`;
  if ("text" in t) return `"${t.text}"`;
  return t.selector;
}

/** One line per command for a monitor. Typed values (fill, select) never appear. */
export function summarizeCmd(cmd: Cmd): string {
  switch (cmd.cmd) {
    case "open":
      return oneLine(`open ${cmd.url}`);
    case "click":
      return oneLine(`click ${targetText(cmd.target)}`);
    case "fill":
      return oneLine(`fill ${targetText(cmd.target)}`);
    case "select":
      return oneLine(`select ${targetText(cmd.target)}`);
    case "press":
      return oneLine(`press ${cmd.key}`);
    case "wait":
      return oneLine(`wait ${cmd.text !== undefined ? `"${cmd.text}"` : (cmd.selector ?? `${cmd.ms ?? 0}ms`)}`);
    case "expect":
      return oneLine(`expect ${cmd.kind} "${cmd.value}"`);
    case "els":
      return oneLine(`els${cmd.all ? " --all" : ""}${cmd.filter ? ` ${cmd.filter}` : ""}`);
    case "js":
      return oneLine(`js ${cmd.expression}`);
    case "drive":
      return oneLine(`drive until ${cmd.until}`);
    case "mouse":
      return `mouse ${cmd.action} ${cmd.x},${cmd.y}`;
    case "drag":
      return `drag ${cmd.fromX},${cmd.fromY} → ${cmd.toX},${cmd.toY}`;
    case "key":
      return oneLine(`key ${cmd.action} ${cmd.key}`);
    case "wheel":
      return `wheel ${cmd.deltaY}`;
    case "tabNew":
      return oneLine(`tab new${cmd.url ? ` ${cmd.url}` : ""}${cmd.background ? " (background)" : ""}`);
    case "tabSelect":
      return `tab select ${cmd.index}`;
    case "tabClose":
      return `tab close${cmd.scope ? ` --${cmd.scope}` : ""}`;
    case "recordStart":
      return `record start ${cmd.slug}`;
    case "recordStop":
      return "record stop";
    default:
      return cmd.cmd;
  }
}

/** Reads the x-bx-client header; anything malformed is simply "no tag". */
export function parseClientTag(header: string | string[] | undefined): ClientTag | null {
  if (typeof header !== "string" || header === "") return null;
  try {
    const parsed = ClientTagSchema.safeParse(JSON.parse(decodeURIComponent(header)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function tabOf(cmd: Cmd): number | undefined {
  return "tab" in cmd ? cmd.tab : undefined;
}

/** Every /cmd, from begin to end. The idle reaper reads `inFlightCount`. */
export class Journal {
  private nextId = 1;
  private readonly live = new Map<number, DebugCmd>();
  private readonly done: DebugCmdDone[] = [];
  private readonly clients = new Map<string, DebugClient>();
  private readonly byCmd = new Map<string, { n: number; errors: number; ms: number }>();
  private commands = 0;
  private errors = 0;

  begin(cmd: Cmd, tag: ClientTag | null): number {
    const id = this.nextId++;
    const now = Date.now();
    const client = tag ? this.touchClient(tag, now) : undefined;
    this.live.set(id, { id, cmd: cmd.cmd, summary: summarizeCmd(cmd), tab: tabOf(cmd), client, startedAt: now });
    return id;
  }

  end(id: number, error: BxError | null): void {
    const entry = this.live.get(id);
    if (!entry) return;
    this.live.delete(id);
    const ms = Date.now() - entry.startedAt;
    const done: DebugCmdDone = { ...entry, ms, ok: error === null };
    if (error) done.error = oneLine(`${error.code}: ${error.message}`, ERROR_CAP);
    this.done.push(done);
    if (this.done.length > RECENT_CAP) this.done.shift();
    this.commands++;
    if (error) this.errors++;
    const stats = this.byCmd.get(entry.cmd) ?? { n: 0, errors: 0, ms: 0 };
    stats.n++;
    stats.ms += ms;
    if (error) stats.errors++;
    this.byCmd.set(entry.cmd, stats);
  }

  get inFlightCount(): number {
    return this.live.size;
  }

  snapshot(): Pick<DebugResult, "inFlight" | "recent" | "totals" | "clients"> {
    return {
      inFlight: [...this.live.values()],
      recent: [...this.done],
      totals: { commands: this.commands, errors: this.errors, byCmd: Object.fromEntries(this.byCmd) },
      clients: [...this.clients.values()],
    };
  }

  private touchClient(tag: ClientTag, now: number): string {
    // A terminal's CLI is a new process per command, so the pid can't be the
    // key; the Claude session (else the folder) is what stays put.
    const key = tag.session ?? tag.cwd ?? "anonymous";
    const known = this.clients.get(key);
    if (known) {
      known.lastSeen = now;
      known.commands++;
      if (tag.pid !== undefined) known.pid = tag.pid;
      if (tag.via !== undefined) known.via = tag.via;
      if (tag.cwd !== undefined) known.cwd = tag.cwd;
      return key;
    }
    this.clients.set(key, { key, ...tag, firstSeen: now, lastSeen: now, commands: 1 });
    if (this.clients.size > CLIENTS_CAP) {
      let oldest: DebugClient | null = null;
      for (const c of this.clients.values()) if (!oldest || c.lastSeen < oldest.lastSeen) oldest = c;
      if (oldest) this.clients.delete(oldest.key);
    }
    return key;
  }
}

const LOOP_RESOLUTION_MS = 20;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loopDelay.enable();

// The histogram measures each sampling timer's whole interval, so an idle loop
// reads about the resolution itself; report only the delay beyond it.
const nsToMs = (ns: number): number =>
  Number.isFinite(ns) ? Math.max(0, Math.round((ns / 1e6 - LOOP_RESOLUTION_MS) * 100) / 100) : 0;

export interface DebugContext {
  session: Session;
  journal: Journal;
  profile: string;
  headless: boolean;
  startedAt: number;
  recording: string | null;
  lastActivityAt: number;
  idleLimitMs: number;
}

export async function collectDebug(ctx: DebugContext): Promise<DebugResult> {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const loop = { mean: nsToMs(loopDelay.mean), p99: nsToMs(loopDelay.percentile(99)), max: nsToMs(loopDelay.max) };
  loopDelay.reset();
  const { pages, internals } = await ctx.session.debugInfo();
  return {
    v: DEBUG_VERSION,
    profile: ctx.profile,
    pid: process.pid,
    headless: ctx.headless,
    startedAt: ctx.startedAt,
    uptimeMs: Date.now() - ctx.startedAt,
    node: {
      version: process.version,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      loopDelayMs: loop,
      gcExposed: typeof globalThis.gc === "function",
    },
    browserRunning: ctx.session.browserRunning,
    recording: ctx.recording,
    idle: { lastActivityAt: ctx.lastActivityAt, limitMs: ctx.idleLimitMs },
    ...ctx.journal.snapshot(),
    internals,
    pages,
  };
}

export function runGc(): DebugGcResult {
  const heapBefore = process.memoryUsage().heapUsed;
  const gc = globalThis.gc;
  if (typeof gc !== "function") return { ran: false, heapBefore, heapAfter: heapBefore };
  gc();
  return { ran: true, heapBefore, heapAfter: process.memoryUsage().heapUsed };
}

/** Synchronous and slow (seconds), and briefly doubles the heap. */
export async function heapSnapshot(profile: string): Promise<DebugHeapSnapshotResult> {
  const dir = path.join(os.homedir(), BX_DIR_NAME, HEAPS_DIR);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const started = Date.now();
  const file = writeHeapSnapshot(path.join(dir, `${profile}-${stamp}.heapsnapshot`));
  const ms = Date.now() - started;
  const { size } = await stat(file);
  return { path: file, bytes: size, ms };
}
