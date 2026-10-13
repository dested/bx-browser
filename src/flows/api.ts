// The typed flow surface. Flow files import this as "bx/flow" (see the
// package exports map) and default-export `flow(name, fn)`.

import { writeFile } from "node:fs/promises";
import { cmd, parseTarget } from "../client.ts";
import type {
  ActionResult,
  BxError,
  Cmd,
  ConsoleEntry,
  DriveResult,
  ElsResult,
  ExpectResult,
  JsResult,
  SnapResult,
  TabsResult,
  TextResult,
} from "../protocol.ts";

export interface Flow {
  name: string;
  fn: (b: FlowContext) => Promise<void>;
}

export function flow(name: string, fn: (b: FlowContext) => Promise<void>): Flow {
  return { name, fn };
}

export class FlowAssertionError extends Error {
  constructor(public detail: string) {
    super(detail);
    this.name = "FlowAssertionError";
  }
}

/** A step the daemon refused: keeps the whole BxError, near matches included. */
export class FlowStepError extends Error {
  constructor(
    public readonly label: string,
    public readonly error: BxError,
  ) {
    super(error.message);
    this.name = "FlowStepError";
  }
}

export interface FlowRunEvents {
  onStep(label: string, ms: number): void;
}

type MouseCmd = Extract<Cmd, { cmd: "mouse" }>;
export type MouseAction = MouseCmd["action"];
export type MouseButton = NonNullable<MouseCmd["button"]>;

/** `in`: the element x/y are measured from — same target syntax as click. */
export interface MouseOptions {
  in?: string;
  button?: MouseButton;
}
export interface DragOptions {
  in?: string;
  steps?: number;
  /** "pointer" dispatches PointerEvents for touch-none/pointer-intent DnD. */
  mode?: "mouse" | "pointer";
  holdMs?: number;
  stepDelayMs?: number;
}
export interface WheelOptions {
  x?: number;
  y?: number;
  in?: string;
}

export interface FlowContextOptions {
  /** Passed to the daemon if this flow has to start it. */
  headless?: boolean;
  /**
   * Open the flow's tab in the background (default) so it doesn't take over
   * the active tab. A recorded flow opens it in front: a background tab may
   * not paint, and the video would come out blank.
   */
  background?: boolean;
}

/** Commands that take a `tab` pin, i.e. everything a flow step sends. */
type PinnableCmd<C = Cmd> = C extends Cmd ? ("tab" extends keyof C ? C : never) : never;

function q(s: string): string {
  return JSON.stringify(s);
}

function errorOf(c: ConsoleEntry): boolean {
  return c.level === "error" || c.level === "pageerror";
}

export class FlowContext {
  private tab: number | null = null;
  private opening: Promise<number> | null = null;

  constructor(
    private readonly profile: string,
    private readonly events?: FlowRunEvents,
    private readonly opts: FlowContextOptions = {},
  ) {}

  /** The flow's own tab id, once its first step has opened it. */
  get tabId(): number | null {
    return this.tab;
  }

  private send<T>(c: Cmd) {
    return cmd<T>(this.profile, c, this.opts.headless === undefined ? undefined : { headless: this.opts.headless });
  }

  // Every flow works in a tab of its own, opened on its first step and pinned
  // on every step after, so it runs beside whatever else drives the profile.
  private ensureTab(): Promise<number> {
    if (this.tab !== null) return Promise.resolve(this.tab);
    this.opening ??= this.send<TabsResult>({ cmd: "tabNew", background: this.opts.background ?? true }).then(
      (res) => {
        if (!res.ok) throw new FlowStepError("open the flow's tab", res.error);
        const created = res.data.created;
        if (!created) {
          throw new FlowStepError("open the flow's tab", { code: "internal", message: "tabNew returned no tab" });
        }
        this.tab = created.id;
        return created.id;
      },
    );
    return this.opening;
  }

  /** Closes the flow's tab. Safe to call twice, or when the tab is already gone. */
  async close(): Promise<void> {
    const tab = this.tab;
    this.tab = null;
    this.opening = null;
    if (tab === null) return;
    await this.send({ cmd: "tabClose", tab }).catch(() => undefined);
  }

  // Every verb funnels through here so timing, labelling, pinning and error
  // shape are identical across the API. The label is reported even when the
  // step throws — the runner uses the last label to say where a flow failed.
  private async step<T>(label: string, c: PinnableCmd): Promise<T> {
    const started = Date.now();
    try {
      const tab = await this.ensureTab();
      const res = await this.send<T>({ ...c, tab });
      if (!res.ok) throw new FlowStepError(label, res.error);
      return res.data;
    } finally {
      this.events?.onStep(label, Date.now() - started);
    }
  }

  /**
   * After a failure: a screenshot and an `els` dump of the flow's tab, written
   * to `<base>.fail.png` and `<base>.fail-els.txt`. Best effort; returns what
   * it saved.
   */
  async captureFailure(base: string): Promise<string[]> {
    const tab = this.tab;
    if (tab === null) return [];
    const saved: string[] = [];
    const snap = await this.send<SnapResult>({ cmd: "snap", path: `${base}.fail.png`, tab }).catch(() => null);
    if (snap?.ok) saved.push(snap.data.path);
    const els = await this.send<ElsResult>({ cmd: "els", all: true, tab }).catch(() => null);
    if (els?.ok) {
      const file = `${base}.fail-els.txt`;
      await writeFile(file, `${els.data.rendered}\n`);
      saved.push(file);
    }
    return saved;
  }

  /** Console errors from this flow's tab (newest last, at most the daemon's console cap). */
  async consoleErrors(): Promise<ConsoleEntry[]> {
    const tab = this.tab;
    if (tab === null) return [];
    const res = await this.send<ConsoleEntry[]>({ cmd: "console", tab }).catch(() => null);
    if (!res?.ok) return [];
    // A daemon that predates tab-tagged entries returns every tab's; keep ours.
    return res.data.filter((e) => errorOf(e) && (e.tab === undefined || e.tab === tab));
  }

  async open(url: string): Promise<void> {
    await this.step(`open ${url}`, { cmd: "open", url });
  }

  async click(target: string): Promise<void> {
    await this.step<ActionResult>(`click ${q(target)}`, {
      cmd: "click",
      target: parseTarget(target),
    });
  }

  async fill(target: string, value: string): Promise<void> {
    await this.step<ActionResult>(`fill ${q(target)} = ${q(value)}`, {
      cmd: "fill",
      target: parseTarget(target),
      value,
    });
  }

  async press(key: string): Promise<void> {
    await this.step<ActionResult>(`press ${key}`, { cmd: "press", key });
  }

  async select(target: string, value: string): Promise<void> {
    await this.step<ActionResult>(`select ${q(target)} = ${q(value)}`, {
      cmd: "select",
      target: parseTarget(target),
      value,
    });
  }

  async waitText(text: string): Promise<void> {
    await this.step<ActionResult>(`waitText ${q(text)}`, { cmd: "wait", text });
  }

  async waitFor(selector: string): Promise<void> {
    await this.step<ActionResult>(`waitFor ${q(selector)}`, { cmd: "wait", selector });
  }

  async sleep(ms: number): Promise<void> {
    await this.step<ActionResult>(`sleep ${ms}ms`, { cmd: "wait", ms });
  }

  async expectText(text: string): Promise<void> {
    const r = await this.step<ExpectResult>(`expectText ${q(text)}`, {
      cmd: "expect",
      kind: "text",
      value: text,
    });
    if (!r.pass) throw new FlowAssertionError(r.detail);
  }

  async expectUrl(part: string): Promise<void> {
    const r = await this.step<ExpectResult>(`expectUrl ${q(part)}`, {
      cmd: "expect",
      kind: "url",
      value: part,
    });
    if (!r.pass) throw new FlowAssertionError(r.detail);
  }

  async expectVisible(target: string): Promise<void> {
    const r = await this.step<ExpectResult>(`expectVisible ${q(target)}`, {
      cmd: "expect",
      kind: "visible",
      value: target,
    });
    if (!r.pass) throw new FlowAssertionError(r.detail);
  }

  async expectNotVisible(target: string): Promise<void> {
    const r = await this.step<ExpectResult>(`expectNotVisible ${q(target)}`, {
      cmd: "expect",
      kind: "notVisible",
      value: target,
    });
    if (!r.pass) throw new FlowAssertionError(r.detail);
  }

  async snap(path?: string): Promise<string> {
    const r = await this.step<SnapResult>(path ? `snap ${path}` : "snap", { cmd: "snap", path });
    return r.path;
  }

  async text(selector?: string): Promise<string> {
    const r = await this.step<TextResult>(selector ? `text ${q(selector)}` : "text", {
      cmd: "text",
      selector,
    });
    return r.text;
  }

  async expectNoConsoleErrors(): Promise<void> {
    const started = Date.now();
    try {
      const errors = await this.consoleErrors();
      if (errors.length > 0) {
        const shown = errors.slice(-3).map((e) => e.text).join(" | ");
        throw new FlowAssertionError(`${errors.length} console error${errors.length === 1 ? "" : "s"}: ${shown}`);
      }
    } finally {
      this.events?.onStep("expectNoConsoleErrors", Date.now() - started);
    }
  }

  /** Passes when `expression` (statements allowed; the last value counts) is truthy. */
  async expectJs(expression: string): Promise<void> {
    const label = expression.length > 40 ? `${expression.slice(0, 40)}…` : expression;
    const r = await this.step<JsResult>(`expectJs ${label}`, { cmd: "js", expression });
    let value: unknown = r.value;
    try {
      value = JSON.parse(r.value);
    } catch {
      // not JSON: judge the raw string
    }
    if (!value) throw new FlowAssertionError(`expectJs ${label} was ${r.value}`);
  }

  async js(expression: string): Promise<string> {
    const label = expression.length > 40 ? `${expression.slice(0, 40)}…` : expression;
    const r = await this.step<JsResult>(`js ${label}`, { cmd: "js", expression });
    return r.value;
  }

  // Installs an in-page controller once, then polls `until` daemon-side until it
  // is truthy. A falsy result at the timeout is a flow failure, like an expect.
  async drive(
    install: string,
    until: string,
    opts?: { timeoutMs?: number; pollMs?: number },
  ): Promise<void> {
    const label = until.length > 40 ? `${until.slice(0, 40)}…` : until;
    const r = await this.step<DriveResult>(`drive until ${label}`, {
      cmd: "drive",
      install,
      until,
      timeoutMs: opts?.timeoutMs,
      pollMs: opts?.pollMs,
    });
    if (!r.satisfied) {
      throw new FlowAssertionError(
        `drive predicate not satisfied after ${r.elapsedMs}ms (${r.polls} polls)` +
          ` — last value: ${r.finalValue}`,
      );
    }
  }

  // Coordinate verbs: for canvases, games and anything else without addressable
  // DOM. With `in`, x/y are relative to that element's top-left.
  async mouse(action: MouseAction, x: number, y: number, opts?: MouseOptions): Promise<void> {
    const where = opts?.in === undefined ? "" : ` in ${q(opts.in)}`;
    await this.step<ActionResult>(`mouse ${action} ${x},${y}${where}`, {
      cmd: "mouse",
      action,
      x,
      y,
      in: opts?.in === undefined ? undefined : parseTarget(opts.in),
      button: opts?.button,
    });
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    opts?: DragOptions,
  ): Promise<void> {
    const where = opts?.in === undefined ? "" : ` in ${q(opts.in)}`;
    const mode = opts?.mode === "pointer" ? " (pointer)" : "";
    await this.step<ActionResult>(`drag ${fromX},${fromY} → ${toX},${toY}${where}${mode}`, {
      cmd: "drag",
      fromX,
      fromY,
      toX,
      toY,
      in: opts?.in === undefined ? undefined : parseTarget(opts.in),
      steps: opts?.steps,
      mode: opts?.mode,
      holdMs: opts?.holdMs,
      stepDelayMs: opts?.stepDelayMs,
    });
  }

  async keyDown(key: string): Promise<void> {
    await this.step<ActionResult>(`keyDown ${key}`, { cmd: "key", action: "down", key });
  }

  async keyUp(key: string): Promise<void> {
    await this.step<ActionResult>(`keyUp ${key}`, { cmd: "key", action: "up", key });
  }

  async wheel(deltaY: number, opts?: WheelOptions): Promise<void> {
    await this.step<ActionResult>(`wheel ${deltaY}`, {
      cmd: "wheel",
      deltaY,
      x: opts?.x,
      y: opts?.y,
      in: opts?.in === undefined ? undefined : parseTarget(opts.in),
    });
  }

  async back(): Promise<void> {
    await this.step<ActionResult>("back", { cmd: "back" });
  }

  async reload(): Promise<void> {
    await this.step<ActionResult>("reload", { cmd: "reload" });
  }
}
