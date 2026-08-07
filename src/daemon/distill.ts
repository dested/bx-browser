// DOM distillation: the whole point of bx. One page.evaluate collects every
// plausibly-interactive element, and rendering enforces the character budget so
// no caller can flood a model context.

import { BUDGET, type El, type ElsResult, type RefEntry } from "../protocol.ts";
import type { Page } from "playwright-core";

/** RefEntry before the session stamps it with the current generation. */
export type RefCandidate = Omit<RefEntry, "generation">;

export interface DistillResult {
  els: El[];
  refEntries: RefCandidate[];
  total: number;
}

interface RawEl {
  tag: string;
  role: string;
  name: string;
  state: string[];
  testid: string | null;
  id: string | null;
  cssPath: string;
}

export async function distillPage(page: Page): Promise<DistillResult> {
  const raw: RawEl[] = await page.evaluate(() => {
    const CANDIDATES =
      'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="option"], [onclick], [contenteditable="true"], [tabindex]';

    const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      // offsetParent is null for display:none subtrees, but also legitimately
      // null for fixed-position elements — hence the position guard.
      if (el instanceof HTMLElement && style.position !== "fixed" && el.offsetParent === null) {
        return false;
      }
      let ancestor = el.parentElement;
      for (let i = 0; i < 3 && ancestor; i++) {
        const s = getComputedStyle(ancestor);
        if (s.display === "none" || s.visibility === "hidden") return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    };

    const roleOf = (el: Element): string => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button" || tag === "summary") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el.getAttribute("type") ?? "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button" || type === "reset") return "button";
        return "textbox";
      }
      return tag;
    };

    const nameOf = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const aria = el.getAttribute("aria-label");
      if (aria) return squash(aria);

      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) {
        const label = el.labels && el.labels.length > 0 ? el.labels[0] : null;
        const labelText = label ? squash(label.innerText || label.textContent || "") : "";
        if (labelText) return labelText;
      }
      const wrapping = el.closest("label");
      if (wrapping && wrapping !== el) {
        const text = squash(wrapping.innerText || wrapping.textContent || "");
        if (text) return text;
      }

      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return squash(placeholder);

      if (el instanceof HTMLElement && (tag === "button" || tag === "a" || tag === "summary")) {
        const text = squash(el.innerText);
        if (text) return text;
      }

      if (el instanceof HTMLInputElement) {
        const type = (el.getAttribute("type") ?? "text").toLowerCase();
        if ((type === "submit" || type === "button" || type === "reset") && el.value) {
          return squash(el.value);
        }
      }

      const title = el.getAttribute("title");
      if (title) return squash(title);

      const img = el.querySelector("img[alt]");
      const alt = img?.getAttribute("alt");
      if (alt) return squash(alt);

      if (el instanceof HTMLElement) {
        const text = squash(el.innerText);
        if (text) return text;
      }
      return "";
    };

    const stateOf = (el: Element): string[] => {
      const state: string[] = [];
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") {
        state.push("disabled");
      }
      if (
        (el instanceof HTMLInputElement && el.checked) ||
        el.getAttribute("aria-checked") === "true"
      ) {
        state.push("checked");
      }
      if (
        (el instanceof HTMLOptionElement && el.selected) ||
        el.getAttribute("aria-selected") === "true"
      ) {
        state.push("selected");
      }
      if (el.getAttribute("aria-expanded") === "true") state.push("expanded");
      return state;
    };

    const cssPathOf = (el: Element): string => {
      const segments: string[] = [];
      let current: Element | null = el;
      while (current !== null && current.tagName.toLowerCase() !== "body" && segments.length < 12) {
        const parent: Element | null = current.parentElement;
        let nth = 1;
        if (parent !== null) {
          const tagName = current.tagName;
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === tagName);
          nth = sameTag.indexOf(current) + 1;
        }
        segments.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${nth})`);
        current = parent;
      }
      return segments.join(" > ");
    };

    const out: RawEl[] = [];
    for (const el of Array.from(document.querySelectorAll(CANDIDATES))) {
      if (el.getAttribute("tabindex") === "-1") continue;
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const testid = el.getAttribute("data-testid");
      const id = el.id === "" ? null : el.id;
      const name = nameOf(el).slice(0, 80);
      const formControl = tag === "input" || tag === "textarea" || tag === "select";
      if (!name && !testid && !id && !formControl) continue;
      out.push({ tag, role: roleOf(el), name, state: stateOf(el), testid, id, cssPath: cssPathOf(el) });
    }
    return out;
  });

  const els: El[] = raw.map((r, i) => ({
    ref: i + 1,
    tag: r.tag,
    role: r.role,
    name: r.name,
    state: r.state,
    testid: r.testid ?? undefined,
    id: r.id ?? undefined,
  }));

  const refEntries: RefCandidate[] = raw.map((r, i) => ({
    ref: i + 1,
    testid: r.testid ?? undefined,
    domId: r.id ?? undefined,
    role: r.name ? { role: r.role, name: r.name } : undefined,
    cssPath: r.cssPath,
  }));

  return { els, refEntries, total: els.length };
}

function renderLine(el: El): string {
  const label = el.name
    ? `"${el.name}"`
    : el.testid
      ? `{${el.testid}}`
      : el.id
        ? `#${el.id}`
        : `<${el.tag}>`;
  const state = el.state.length > 0 ? ` (${el.state.join(", ")})` : "";
  return `[${el.ref}] ${el.role} ${label}${state}`;
}

/** Character-budgeted fit: keeps as many leading elements as the budget allows. */
function fit(els: El[], budget: number): { kept: El[]; text: string } {
  const kept: El[] = [];
  let length = 0;
  for (const el of els) {
    const line = renderLine(el);
    const cost = kept.length === 0 ? line.length : line.length + 1;
    if (kept.length > 0 && length + cost > budget) break;
    kept.push(el);
    length += cost;
  }
  return { kept, text: kept.map(renderLine).join("\n") };
}

const MORE_LINE_RESERVE = 64;

/** Generation is stamped by the session, which owns the ref registry. */
export function renderEls(
  scan: DistillResult,
  opts: { all?: boolean; filter?: string },
): Omit<ElsResult, "generation"> {
  const needle = opts.filter?.toLowerCase();
  const matched =
    needle === undefined || needle === ""
      ? scan.els
      : scan.els.filter((e) =>
          `${e.name} ${e.testid ?? ""} ${e.id ?? ""} ${e.role}`.toLowerCase().includes(needle),
        );

  const capped = opts.all ? matched : matched.slice(0, BUDGET.ELS_MAX_ELEMENTS);
  let { kept, text } = fit(capped, BUDGET.ELS_MAX_CHARS);
  let truncated = kept.length < matched.length;
  if (truncated) {
    // Re-fit leaving room for the trailing "+N more" line.
    ({ kept, text } = fit(capped, BUDGET.ELS_MAX_CHARS - MORE_LINE_RESERVE));
    truncated = kept.length < matched.length;
  }

  const hint = opts.all ? "use --filter <text>" : "use --all or --filter <text>";
  const rendered = truncated ? `${text}\n(+${matched.length - kept.length} more — ${hint})` : text;

  return { els: kept, total: scan.total, truncated, rendered };
}
