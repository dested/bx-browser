// Target resolution and `els` (C1 C2 C3 C8 S5), daemon side. The in-page work
// is distill.ts `bxPage`; this module keeps each tab's ref state, turns a
// resolved element into a Playwright locator, and maps outcomes to BxErrors.
// Node runtime rules (see cliffnotes "Runtime split").

import type { FrameLocator, Locator, Page } from "playwright-core";
import { z } from "zod";
import { BUDGET, type BxError, type El, type ElsResult, type Target } from "../protocol.ts";
import { bxPage, renderList, type ElsDiff, type MatchSpec, type PageOp, type PageOut, type ResolveOut } from "./distill.ts";

// The page answers with a JSON string: Playwright's structured serialization
// of a 6,000-element result costs ~160 ms, JSON.parse a few.
const PAGE_SOURCE = bxPage.toString();

const ElSchema = z.object({
  ref: z.number(),
  tag: z.string(),
  role: z.string(),
  name: z.string(),
  state: z.array(z.string()),
  testid: z.string().optional(),
  id: z.string().optional(),
  frame: z.string().optional(),
  dialog: z.boolean().optional(),
});
const ResolveOutSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), ref: z.number(), frames: z.array(z.number()), stable: z.string() }),
  z.object({ status: z.literal("ambiguous"), tied: z.array(ElSchema) }),
  z.object({ status: z.literal("none"), near: z.array(ElSchema) }),
  z.object({ status: z.literal("gone") }),
  z.object({ status: z.literal("unknown") }),
]);
const PageOutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scan"), next: z.number(), els: z.array(ElSchema), total: z.number() }),
  z.object({ kind: z.literal("resolve"), next: z.number(), result: ResolveOutSchema }),
]);

/** One tab's ref bookkeeping. The elements themselves live in the page (window.__bx). */
export interface PageRefState {
  /** Next ref id to hand out; ids are never reused within the tab. */
  nextRef: number;
  /** Scans so far; reported as ElsResult.generation. */
  scans: number;
  /** ref → role/name/state signature of what the caller has been shown (els --diff). */
  seen: Map<number, string> | null;
}

const states = new WeakMap<Page, PageRefState>();

export function pageRefs(page: Page): PageRefState {
  const known = states.get(page);
  if (known) return known;
  const fresh: PageRefState = { nextRef: 1, scans: 0, seen: null };
  states.set(page, fresh);
  return fresh;
}

/** Refs handed out in this tab so far (the /debug registry size). */
export function refCount(page: Page): number {
  return (states.get(page)?.nextRef ?? 1) - 1;
}

type ResolveCode = "target_not_found" | "stale_ref" | "ambiguous";

export class ResolveError extends Error {
  readonly code: ResolveCode;
  readonly nearMatches?: El[];

  constructor(code: ResolveCode, message: string, nearMatches?: El[]) {
    super(message);
    this.name = "ResolveError";
    this.code = code;
    if (nearMatches !== undefined) this.nearMatches = nearMatches;
  }

  /** The daemon sends errors as JSON; Error.message is not enumerable. */
  toJSON(): BxError {
    const out: BxError = { code: this.code, message: this.message };
    if (this.nearMatches !== undefined) out.nearMatches = this.nearMatches;
    return out;
  }
}

export interface Resolved {
  locator: Locator;
  /** Replay-stable identity: testid, else accessible name, else a selector. Never a ref. */
  stable: string;
}

const CONTEXT_GONE = /Execution context was destroyed|Cannot find context|Frame was detached/;
const POLL_MS = 100;
const POLL_CAP_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(page: Page, op: PageOp): Promise<PageOut> {
  const json = await page.evaluate<unknown>(`JSON.stringify((${PAGE_SOURCE})(${JSON.stringify(op)}))`);
  if (typeof json !== "string") throw new Error("bxPage returned no JSON (the page replaced JSON.stringify?)");
  const out: PageOut = PageOutSchema.parse(JSON.parse(json));
  const state = pageRefs(page);
  state.nextRef = Math.max(state.nextRef, out.next);
  return out;
}

async function resolveOnce(page: Page, op: Extract<PageOp, { op: "resolve" }>): Promise<ResolveOut | null> {
  let out: PageOut;
  try {
    out = await run(page, op);
  } catch (err) {
    // A navigation replaced the document mid-pass: try again on the new one.
    if (err instanceof Error && CONTEXT_GONE.test(err.message)) return null;
    throw err;
  }
  if (out.kind !== "resolve") throw new Error("bxPage answered a resolve with a scan");
  return out.result;
}

function locate(page: Page, frames: number[], ref: number): Locator {
  const sel = (id: number): string => `[data-bx-ref="${id}"]`;
  let scope: Page | FrameLocator = page;
  for (const f of frames) scope = scope.frameLocator(sel(f));
  return scope.locator(sel(ref)).first();
}

function describe(target: Target): string {
  if ("ref" in target) return target.orText !== undefined ? `"${target.orText}"` : `ref ${target.ref}`;
  if ("testid" in target) return `testid "${target.testid}"`;
  if ("label" in target) return `label "${target.label}"`;
  if ("role" in target) return target.name !== undefined ? `${target.role} "${target.name}"` : `any ${target.role}`;
  if ("selector" in target) return target.selector;
  return `"${target.text}"`;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Resolves a target to one element. Exact beats fuzzy, hidden never wins, and
 * a tie at the top is `ambiguous` unless `first`. A ref resolves to the element
 * `els` listed while that element is on the page; `{ref, orText}` falls back to
 * orText as text. Text-like targets poll up to min(timeoutMs, 2000) ms for the
 * element to appear. The winner is marked `data-bx-ref` and the locator points
 * at the mark (through its iframes).
 */
export async function resolveTarget(
  page: Page,
  target: Target,
  opts: { timeoutMs?: number } = {},
): Promise<Resolved> {
  if ("selector" in target) return { locator: page.locator(target.selector).first(), stable: target.selector };

  let ref: number | undefined;
  let match: MatchSpec | undefined;
  let first = false;
  let text = "";
  if ("ref" in target) {
    ref = target.ref;
    if (target.orText !== undefined) {
      text = target.orText;
      match = { kind: "text", text, exact: false };
    }
  } else if ("testid" in target) {
    text = target.testid;
    match = { kind: "testid", text, exact: target.exact === true };
    first = target.first === true;
  } else if ("label" in target) {
    text = target.label;
    match = { kind: "label", text, exact: target.exact === true };
    first = target.first === true;
  } else if ("role" in target) {
    text = target.name ?? target.role;
    const spec: MatchSpec = { kind: "role", role: target.role, exact: target.exact === true };
    if (target.name !== undefined && target.name !== "") spec.text = target.name;
    match = spec;
    first = target.first === true;
  } else {
    text = target.text;
    match = { kind: "text", text, exact: target.exact === true };
    first = target.first === true;
  }

  const windowMs = Math.min(opts.timeoutMs ?? BUDGET.DEFAULT_TIMEOUT_MS, POLL_CAP_MS);
  const deadline = Date.now() + windowMs;
  for (;;) {
    const last = Date.now() + POLL_MS >= deadline;
    const op: Extract<PageOp, { op: "resolve" }> = {
      op: "resolve",
      nextRef: pageRefs(page).nextRef,
      first,
      near: last ? words(text) : null,
    };
    if (ref !== undefined) op.ref = ref;
    if (match !== undefined) op.match = match;
    const result = await resolveOnce(page, op);

    if (result !== null) {
      if (result.status === "found") return { locator: locate(page, result.frames, result.ref), stable: result.stable };
      if (result.status === "ambiguous") {
        throw new ResolveError(
          "ambiguous",
          `${describe(target)} matches ${result.tied.length} elements equally well — use one of these refs, --exact, or --first`,
          result.tied,
        );
      }
      if (result.status === "gone") {
        throw new ResolveError("stale_ref", `ref ${ref} is gone (the element left the page) — re-run els`);
      }
      if (result.status === "unknown") {
        // The page never issued it; the tab did (an earlier document): stale, not unknown.
        if (ref !== undefined && ref < pageRefs(page).nextRef) {
          throw new ResolveError("stale_ref", `ref ${ref} is gone (the element left the page) — re-run els`);
        }
        throw new ResolveError("target_not_found", `ref ${ref} is unknown — run els`);
      }
      if (last) {
        throw new ResolveError(
          "target_not_found",
          `no visible element matches ${describe(target)} (waited ${windowMs} ms)`,
          result.near,
        );
      }
    } else if (last) {
      throw new ResolveError("target_not_found", `no visible element matches ${describe(target)} (the page kept navigating)`);
    }
    await sleep(Math.max(0, Math.min(POLL_MS, deadline - Date.now())));
  }
}

/** Up to five visible elements whose name, test id or id shares a word with `text`, registered as refs. */
export async function nearMatches(page: Page, text: string): Promise<El[]> {
  try {
    const result = await resolveOnce(page, { op: "resolve", nextRef: pageRefs(page).nextRef, first: false, near: words(text) });
    return result !== null && result.status === "none" ? result.near : [];
  } catch {
    return [];
  }
}

function signature(el: El): string {
  return `${el.role}\u0000${el.name}\u0000${el.state.join(",")}`;
}

export interface ScanOptions {
  all?: boolean;
  filter?: string;
  diff?: boolean;
  clickables?: boolean;
}

/**
 * `els`: one in-page pass over the document, open shadow roots and same-origin
 * iframes. An open dialog lists first and hides the page behind it; then the
 * viewport top to bottom, then the rest. With `diff`, only what was added or
 * changed since this tab's last listing, plus the refs that went away.
 */
export async function scanEls(page: Page, opts: ScanOptions = {}): Promise<ElsResult> {
  const state = pageRefs(page);
  const diff = opts.diff === true;
  const filter = (opts.filter ?? "").toLowerCase();
  const out = await run(page, {
    op: "scan",
    nextRef: state.nextRef,
    // A diff needs the whole page to know what went away.
    limit: opts.all === true || diff ? 0 : BUDGET.ELS_MAX_ELEMENTS,
    filter: diff ? "" : filter,
    clickables: opts.clickables === true,
  });
  if (out.kind !== "scan") throw new Error("bxPage answered a scan with a resolve");
  state.scans++;

  if (!diff) {
    const rendered = renderList(out.els, out.total, { all: opts.all });
    state.seen = new Map(rendered.els.map((el) => [el.ref, signature(el)]));
    return { generation: state.scans, ...rendered };
  }

  const prev = state.seen ?? new Map<number, string>();
  const current = new Set(out.els.map((el) => el.ref));
  const removed = [...prev.keys()].filter((ref) => !current.has(ref));
  let added = 0;
  let changed = 0;
  const shown: El[] = [];
  for (const el of out.els) {
    const before = prev.get(el.ref);
    if (before === signature(el)) continue;
    if (filter && !`${el.name} ${el.testid ?? ""} ${el.id ?? ""} ${el.role}`.toLowerCase().includes(filter)) continue;
    if (before === undefined) added++;
    else changed++;
    shown.push(el);
  }
  const summary: ElsDiff = { added, removed, changed };
  const rendered = renderList(shown, shown.length, { all: opts.all, diff: summary });
  // What the caller has now seen: everything still present it saw before, plus
  // what this listing showed (unshown changes stay pending for the next diff).
  const seen = new Map<number, string>();
  for (const [ref, sig] of prev) if (current.has(ref)) seen.set(ref, sig);
  for (const el of rendered.els) seen.set(el.ref, signature(el));
  state.seen = seen;
  return { generation: state.scans, ...rendered };
}
