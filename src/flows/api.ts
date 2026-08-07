// The typed flow surface. Flow files import this as "bx/flow" (see the
// package exports map) and default-export `flow(name, fn)`.

import { cmd, parseTarget } from "../client.ts";
import type {
  ActionResult,
  Cmd,
  ExpectResult,
  JsResult,
  SnapResult,
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

function q(s: string): string {
  return JSON.stringify(s);
}

export class FlowContext {
  constructor(
    private readonly profile: string,
    private readonly events?: FlowRunEvents,
  ) {}

  // Every verb funnels through here so timing, labelling and error shape are
  // identical across the API. The label is reported even when the step throws —
  // the runner uses the last label to say where a flow failed.
  private async step<T>(label: string, c: Cmd): Promise<T> {
    const started = Date.now();
    try {
      const res = await cmd<T>(this.profile, c);
      if (!res.ok) throw new Error(res.error.message);
      return res.data;
    } finally {
      this.events?.onStep(label, Date.now() - started);
    }
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

  async js(expression: string): Promise<string> {
    const label = expression.length > 40 ? `${expression.slice(0, 40)}…` : expression;
    const r = await this.step<JsResult>(`js ${label}`, { cmd: "js", expression });
    return r.value;
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
