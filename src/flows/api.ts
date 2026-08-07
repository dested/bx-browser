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

  async back(): Promise<void> {
    await this.step<ActionResult>("back", { cmd: "back" });
  }

  async reload(): Promise<void> {
    await this.step<ActionResult>("reload", { cmd: "reload" });
  }
}
