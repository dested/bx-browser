// DOM distillation: the whole point of bx. `bxPage` is the one in-page pass
// behind `els`, target resolution and near matches; rendering enforces the
// character budget so no caller can flood a model context. resolve.ts owns the
// daemon side (per-tab state, locators, errors).
//
// Identity refs (C3): `window.__bx` holds an id → WeakRef(element) registry and
// its inverse, so a ref names the element itself and survives re-scans. It is
// installed lazily by whichever evaluate gets there first, once per document;
// elements of same-origin iframes live in the top document's registry with the
// chain of iframe ids they sit behind. Ids start from a per-tab counter the
// daemon passes in, so a number is never reused within a tab across
// navigations.
//
// `bxPage` runs in the page as source: it must not reference anything outside
// its own body (types are fine, they are erased).

import { BUDGET, type El, type ElsResult, type RefEntry } from "../protocol.ts";
import type { Page } from "playwright-core";

/** What a target asks the page to score. */
export type MatchSpec =
  | { kind: "text"; text: string; exact: boolean }
  | { kind: "testid"; text: string; exact: boolean }
  | { kind: "label"; text: string; exact: boolean }
  | { kind: "role"; role: string; text?: string; exact: boolean };

export type PageOp =
  | {
      op: "scan";
      nextRef: number;
      limit: number; // 0 = no limit
      filter: string; // lowercase; "" = none
      clickables: boolean;
    }
  | {
      op: "resolve";
      nextRef: number;
      ref?: number; // tried first; a live element wins outright
      match?: MatchSpec; // scored when there is no ref or it is not live
      first: boolean;
      near: string[] | null; // words for near matches when nothing matches
    };

export type ResolveOut =
  | { status: "found"; ref: number; frames: number[]; stable: string }
  | { status: "ambiguous"; tied: El[] }
  | { status: "none"; near: El[] }
  | { status: "gone" }
  | { status: "unknown" };

export type PageOut =
  | { kind: "scan"; next: number; els: El[]; total: number }
  | { kind: "resolve"; next: number; result: ResolveOut };

interface RegEntry {
  el: WeakRef<Element>;
  frames: number[]; // ids of the iframes the element sits behind, outermost first
}

interface Registry {
  v: number;
  byId: Map<number, RegEntry>;
  ids: WeakMap<Element, number>;
  next: number;
  marked: number[]; // ids carrying data-bx-ref, oldest first
}

interface Root {
  node: Document | ShadowRoot;
  frameEls: Element[]; // iframe elements, outermost first
  frameLabel?: string;
  frameIds?: number[];
  dx: number; // offset of this root's viewport inside the top viewport
  dy: number;
}

interface Item {
  el: Element;
  root: Root;
  top: number;
  left: number;
  height: number;
  inView: boolean;
  inDialog: boolean;
}

interface Scored extends Item {
  score: number;
}

export function bxPage(op: PageOp): PageOut {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  // Elements that are interactive on their own.
  const STRONG =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="option"], [role="textbox"], [role="searchbox"], [role="slider"], [role="spinbutton"], [role="treeitem"], [onclick], [contenteditable=""], [contenteditable="true"]';
  const CANDIDATES = `${STRONG}, [tabindex]`;
  // Interactive elements named by their content: text inside them is scored
  // through them, never as a separate text match.
  const CONTENT_NAMED =
    'a[href], button, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"]';
  const NAMED_BY_CONTENT_ROLES = new Set([
    "button",
    "link",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "checkbox",
    "radio",
    "switch",
    "treeitem",
  ]);
  const IMPLICIT_ROLE: Record<string, string> = {
    button: 'button, input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], summary',
    link: "a[href]",
    textbox: 'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="password"], input[type="number"], textarea',
    searchbox: 'input[type="search"]',
    checkbox: 'input[type="checkbox"]',
    radio: 'input[type="radio"]',
    combobox: "select:not([multiple]), input[list]",
    listbox: "select[multiple]",
    slider: 'input[type="range"]',
    heading: "h1, h2, h3, h4, h5, h6",
    img: "img[alt]",
    dialog: "dialog",
    navigation: "nav",
    main: "main",
    list: "ul, ol",
    listitem: "li",
    table: "table",
    row: "tr",
    cell: "td",
    columnheader: "th",
    form: "form",
  };
  const SKIP_TEXT = new Set(["script", "style", "noscript", "template"]);
  const CONTROL_TEXT = new Set(["select", "textarea", "option", "datalist"]);
  const TEXT_CAP = 400;
  const MARK = "data-bx-ref";
  const MARK_KEEP = 16;

  const isTag = <K extends keyof HTMLElementTagNameMap>(el: Element, tag: K): el is HTMLElementTagNameMap[K] =>
    el.localName === tag && el.namespaceURI === HTML_NS;
  const isElement = (n: Node): n is Element => n.nodeType === 1;
  const isShadow = (n: Node): n is ShadowRoot => n.nodeType === 11 && "host" in n;
  const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  const isRegistry = (x: unknown): x is Registry =>
    typeof x === "object" && x !== null && Reflect.get(x, "v") === 1 && Reflect.get(x, "byId") instanceof Map;
  const existing: unknown = Reflect.get(window, "__bx");
  let reg: Registry;
  if (isRegistry(existing)) {
    reg = existing;
  } else {
    reg = { v: 1, byId: new Map(), ids: new WeakMap(), next: 1, marked: [] };
    Object.defineProperty(window, "__bx", { value: reg, configurable: true, enumerable: false, writable: true });
  }
  reg.next = Math.max(reg.next, op.nextRef);
  if (reg.byId.size > 5000) {
    for (const [id, entry] of reg.byId) {
      if (!entry.el.deref()?.isConnected) reg.byId.delete(id);
    }
  }

  const idOf = (el: Element, frames: number[]): number => {
    const known = reg.ids.get(el);
    if (known !== undefined && reg.byId.get(known)?.el.deref() === el) return known;
    const id = reg.next++;
    reg.ids.set(el, id);
    reg.byId.set(id, { el: new WeakRef(el), frames });
    return id;
  };

  // -------------------------------------------------------------------------
  // Tree walking: the document, open shadow roots, same-origin iframes
  // -------------------------------------------------------------------------

  /** The element hosting `n`'s tree: its shadow host, or the iframe its document sits in. */
  const up = (n: Element): Element | null => {
    const root = n.getRootNode();
    if (isShadow(root)) return root.host;
    const view = n.ownerDocument.defaultView;
    return view !== null && view !== window ? view.frameElement : null;
  };

  const box = (el: Element): DOMRect | null => {
    // Transparent native inputs are a deliberate overlay (MUI checkboxes,
    // radios, switches): the click lands on them, so opacity doesn't hide an input.
    const shown =
      el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
      (isTag(el, "input") && el.checkVisibility({ checkVisibilityCSS: true }));
    if (!shown) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };

  const hiddenFromUser = (el: Element): boolean => {
    for (let n: Element | null = el; n !== null; n = up(n)) {
      if (n.closest('[inert], [aria-hidden="true"]') !== null) return true;
    }
    return false;
  };

  const composedContains = (ancestor: Element, el: Element): boolean => {
    for (let n: Element | null = el; n !== null; n = up(n)) {
      if (ancestor.contains(n)) return true;
    }
    return false;
  };

  const frameDoc = (el: Element): Document | null => {
    if (!isTag(el, "iframe")) return null;
    try {
      const doc = el.contentDocument;
      return doc !== null && doc.documentElement !== null ? doc : null;
    } catch {
      return null;
    }
  };

  const frameLabelOf = (el: Element): string => {
    const name = el.getAttribute("name") || el.getAttribute("title") || el.id;
    if (name) return name.slice(0, 60);
    const src = el.getAttribute("src");
    return src ? src.slice(0, 60) : "iframe";
  };

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const roots: Root[] = [];
  const dialogs: Element[] = [];
  const visit = (root: Root): void => {
    roots.push(root);
    // Only a dialog on screen counts: off-canvas drawers keep aria-modal while closed.
    for (const d of Array.from(root.node.querySelectorAll('dialog[open], [aria-modal="true"]'))) {
      const r = box(d);
      if (r === null) continue;
      const top = r.top + root.dy;
      const left = r.left + root.dx;
      if (top < vh && top + r.height > 0 && left < vw && left + r.width > 0) dialogs.push(d);
    }
    for (const el of Array.from(root.node.querySelectorAll("*"))) {
      const shadow = el.shadowRoot;
      if (shadow !== null) visit({ ...root, node: shadow });
      const doc = frameDoc(el);
      if (doc === null) continue;
      const r = box(el);
      if (r === null) continue;
      visit({
        node: doc,
        frameEls: [...root.frameEls, el],
        frameLabel: frameLabelOf(el),
        dx: root.dx + r.left + el.clientLeft,
        dy: root.dy + r.top + el.clientTop,
      });
    }
  };
  visit({ node: document, frameEls: [], dx: 0, dy: 0 });
  // The topmost open dialog scopes the page: listed first, background dropped.
  const scope = dialogs.length > 0 ? (dialogs[dialogs.length - 1] ?? null) : null;

  const frameIdsOf = (root: Root): number[] => {
    if (root.frameIds) return root.frameIds;
    const ids: number[] = [];
    for (const f of root.frameEls) ids.push(idOf(f, [...ids]));
    root.frameIds = ids;
    return ids;
  };

  const itemOf = (el: Element, root: Root): Item | null => {
    const r = box(el);
    if (r === null || hiddenFromUser(el)) return null;
    const top = r.top + root.dy;
    const left = r.left + root.dx;
    const inView = top < vh && top + r.height > 0 && left < vw && left + r.width > 0;
    const inDialog = scope !== null && composedContains(scope, el);
    return { el, root, top, left, height: r.height, inView, inDialog };
  };

  // -------------------------------------------------------------------------
  // Names, roles, state
  // -------------------------------------------------------------------------

  /** textContent, capped, through slots, skipping script/style (and form controls for labels). */
  const textIn = (el: Element, skipControls: boolean): string => {
    // Fast path: a leaf's text is its textContent.
    if (el.childElementCount === 0 && el.shadowRoot === null && !isTag(el, "slot")) {
      const t = el.textContent ?? "";
      return squash(t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) : t);
    }
    let out = "";
    const walk = (n: Node): boolean => {
      const kids: Node[] =
        isElement(n) && isTag(n, "slot") ? n.assignedNodes({ flatten: true }) : Array.from(n.childNodes);
      for (const c of kids) {
        if (c.nodeType === 3) {
          out += c.nodeValue ?? "";
          if (out.length > TEXT_CAP) return false;
        } else if (isElement(c)) {
          if (SKIP_TEXT.has(c.localName) || (skipControls && CONTROL_TEXT.has(c.localName))) continue;
          if (!walk(c.shadowRoot ?? c)) return false;
        }
      }
      return true;
    };
    walk(el.shadowRoot ?? el);
    return squash(out);
  };

  const byIdIn = (el: Element, id: string): Element | null => {
    const root = el.getRootNode();
    return isShadow(root) ? root.getElementById(id) : el.ownerDocument.getElementById(id);
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0] ?? explicit;
    const tag = el.localName;
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (isTag(el, "select")) return el.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (isTag(el, "input")) {
      const type = el.type;
      if (type === "checkbox" || type === "radio") return type;
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      if (el.hasAttribute("list")) return "combobox";
      return "textbox";
    }
    if (el.getAttribute("contenteditable") === "" || el.getAttribute("contenteditable") === "true") return "textbox";
    return tag;
  };

  const isFormControl = (el: Element): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    isTag(el, "input") || isTag(el, "select") || isTag(el, "textarea");

  // `el.labels` costs ~0.1 ms per control on first touch (192 ms for 2,000
  // inputs), so <label for> is looked up in one map per tree instead.
  const labelMaps = new Map<Node, Map<string, Element[]>>();
  const labelsFor = (el: Element): Element[] => {
    const out: Element[] = [];
    if (el.id) {
      const root = el.getRootNode();
      let map = labelMaps.get(root);
      if (map === undefined) {
        map = new Map();
        const tree: Document | ShadowRoot = isShadow(root) ? root : el.ownerDocument;
        for (const label of Array.from(tree.querySelectorAll("label[for]"))) {
          const key = label.getAttribute("for") ?? "";
          map.set(key, [...(map.get(key) ?? []), label]);
        }
        labelMaps.set(root, map);
      }
      out.push(...(map.get(el.id) ?? []));
    }
    const wrapping = el.parentElement?.closest("label");
    if (wrapping && !wrapping.hasAttribute("for")) out.push(wrapping);
    return out;
  };

  /** Label-ish names only: aria-label, aria-labelledby, <label>s. */
  const labelsOf = (el: Element): string[] => {
    const out: string[] = [];
    const aria = el.getAttribute("aria-label");
    if (aria) out.push(squash(aria));
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => byIdIn(el, id))
        .map((ref) => (ref === null ? "" : textIn(ref, true)))
        .join(" ");
      if (squash(text)) out.push(squash(text));
    }
    if (isFormControl(el)) {
      for (const label of labelsFor(el)) {
        const text = textIn(label, true);
        if (text) out.push(text);
      }
    } else {
      const wrapping = el.parentElement?.closest("label");
      const text = wrapping ? textIn(wrapping, true) : "";
      if (text) out.push(text);
    }
    return out.filter((s) => s.length > 0);
  };

  /** Every name an element answers to, display name first. */
  const namesOf = (el: Element): string[] => {
    const out = labelsOf(el);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) out.push(squash(placeholder));
    const role = roleOf(el);
    if (NAMED_BY_CONTENT_ROLES.has(role) && !isFormControl(el)) {
      const text = textIn(el, false);
      if (text) out.push(text);
    }
    if (isTag(el, "input") && (el.type === "submit" || el.type === "button" || el.type === "reset") && el.value) {
      out.push(squash(el.value));
    }
    const title = el.getAttribute("title");
    if (title) out.push(squash(title));
    const alt = el.childElementCount === 0 ? null : el.querySelector("img[alt]")?.getAttribute("alt");
    if (alt) out.push(squash(alt));
    if (out.length === 0 && !isFormControl(el)) {
      const text = textIn(el, false);
      if (text) out.push(text);
    }
    return out.filter((s) => s.length > 0);
  };

  let active: Element | null = document.activeElement;
  for (let i = 0; i < 10 && active !== null; i++) {
    const inner: Element | null = active.shadowRoot?.activeElement ?? frameDoc(active)?.activeElement ?? null;
    if (inner === null || inner === active) break;
    active = inner;
  }

  const stateOf = (el: Element): string[] => {
    const state: string[] = [];
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") state.push("disabled");
    if ((isTag(el, "input") && el.checked) || el.getAttribute("aria-checked") === "true") state.push("checked");
    if ((isTag(el, "option") && el.selected) || el.getAttribute("aria-selected") === "true") state.push("selected");
    if (el.getAttribute("aria-expanded") === "true") state.push("expanded");
    if (el === active) state.push("focused");
    return state;
  };

  const toEl = (it: Item, name: string, role?: string): El => {
    const frames = frameIdsOf(it.root);
    const out: El = {
      ref: idOf(it.el, frames),
      tag: it.el.localName,
      role: role ?? roleOf(it.el),
      name: name.slice(0, 80),
      state: stateOf(it.el),
    };
    const testid = it.el.getAttribute("data-testid");
    if (testid) out.testid = testid;
    if (it.el.id) out.id = it.el.id;
    if (it.root.frameLabel !== undefined) out.frame = it.root.frameLabel;
    if (it.inDialog) out.dialog = true;
    return out;
  };

  /** Dialog first, then the viewport top to bottom, then the rest in document order. */
  /** Reading order: visual rows (vertical centers within half the shorter height) top to bottom, each left to right. */
  const reading = <T extends Item>(items: T[]): T[] => {
    const byCenter = [...items].sort((a, b) => a.top + a.height / 2 - (b.top + b.height / 2));
    const out: T[] = [];
    let row: T[] = [];
    for (const it of byCenter) {
      const head = row[0];
      const center = it.top + it.height / 2;
      if (head !== undefined && center - (head.top + head.height / 2) > Math.max(4, Math.min(head.height, it.height) / 2)) {
        out.push(...row.sort((a, b) => a.left - b.left));
        row = [];
      }
      row.push(it);
    }
    out.push(...row.sort((a, b) => a.left - b.left));
    return out;
  };

  /** Dialog first, then the viewport in reading order, then the rest in document order. */
  const ordered = <T extends Item>(items: T[]): T[] => {
    const dialog = reading(items.filter((i) => i.inDialog));
    const view = reading(items.filter((i) => !i.inDialog && i.inView));
    const rest = items.filter((i) => !i.inDialog && !i.inView);
    return [...dialog, ...view, ...rest];
  };

  const candidates = (): Item[] => {
    const items: Item[] = [];
    for (const root of roots) {
      for (const el of Array.from(root.node.querySelectorAll(CANDIDATES))) {
        if (el.getAttribute("tabindex") === "-1" && !el.matches(STRONG)) continue;
        const it = itemOf(el, root);
        if (it === null || (scope !== null && !it.inDialog)) continue;
        items.push(it);
      }
    }
    return items;
  };

  // -------------------------------------------------------------------------
  // scan (els)
  // -------------------------------------------------------------------------

  if (op.op === "scan") {
    const items = candidates();
    const clickable = new Set<Element>();
    if (op.clickables) {
      for (const root of roots) {
        for (const el of Array.from(root.node.querySelectorAll("*"))) {
          if (el.closest(CANDIDATES) !== null || SKIP_TEXT.has(el.localName)) continue;
          if (getComputedStyle(el).cursor !== "pointer") continue;
          // cursor inherits: list only the outermost pointer element
          const parent = el.parentElement;
          if (parent !== null && getComputedStyle(parent).cursor === "pointer") continue;
          const it = itemOf(el, root);
          if (it === null || (scope !== null && !it.inDialog)) continue;
          items.push(it);
          clickable.add(el);
        }
      }
    }
    const els: El[] = [];
    let skipped = 0;
    const all = ordered(items);
    for (const it of all) {
      if (op.limit > 0 && els.length >= op.limit) break;
      const name = namesOf(it.el)[0] ?? "";
      const tag = it.el.localName;
      const testid = it.el.getAttribute("data-testid");
      if (!name && !testid && !it.el.id && tag !== "input" && tag !== "textarea" && tag !== "select") {
        skipped++;
        continue;
      }
      const role = clickable.has(it.el) ? (it.el.getAttribute("role") ?? "clickable") : roleOf(it.el);
      if (op.filter) {
        const hay = `${name} ${testid ?? ""} ${it.el.id} ${role}`.toLowerCase();
        if (!hay.includes(op.filter)) {
          skipped++;
          continue;
        }
      }
      els.push(toEl(it, name, role));
    }
    // Unprocessed elements are counted as listable: an estimate, never an undercount of what was shown.
    const total = op.filter ? els.length : all.length - skipped;
    return { kind: "scan", next: reg.next, els, total };
  }

  // -------------------------------------------------------------------------
  // resolve
  // -------------------------------------------------------------------------

  const shortPath = (el: Element): string => {
    const parts: string[] = [];
    for (let n: Element | null = el; n !== null && parts.length < 6; n = n.parentElement) {
      if (n.id) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      if (n.localName === "body" || n.localName === "html") break;
      let nth = 1;
      for (let s = n.previousElementSibling; s !== null; s = s.previousElementSibling) {
        if (s.localName === n.localName) nth++;
      }
      parts.unshift(`${n.localName}:nth-of-type(${nth})`);
    }
    return parts.join(" > ");
  };

  const mark = (id: number): void => {
    const el = reg.byId.get(id)?.el.deref();
    if (el === undefined) return;
    el.setAttribute(MARK, String(id));
    reg.marked = reg.marked.filter((m) => m !== id);
    reg.marked.push(id);
    while (reg.marked.length > MARK_KEEP) {
      const old = reg.marked.shift();
      if (old !== undefined) reg.byId.get(old)?.el.deref()?.removeAttribute(MARK);
    }
  };

  const found = (el: Element, frames: number[]): PageOut => {
    const ref = idOf(el, frames);
    for (const f of frames) mark(f);
    mark(ref);
    const stable = el.getAttribute("data-testid") || namesOf(el)[0] || shortPath(el);
    return { kind: "resolve", next: reg.next, result: { status: "found", ref, frames, stable } };
  };

  /** A registered element is live while it, and every iframe it sits behind, is still attached. */
  const live = (el: Element, frames: number[]): boolean => {
    if (!el.isConnected) return false;
    let doc: Document = document;
    for (const f of frames) {
      const frameEl = reg.byId.get(f)?.el.deref();
      if (frameEl === undefined || !frameEl.isConnected || frameEl.ownerDocument !== doc) return false;
      const inner = frameDoc(frameEl);
      if (inner === null) return false;
      doc = inner;
    }
    return el.ownerDocument === doc;
  };

  if (op.ref !== undefined) {
    const entry = reg.byId.get(op.ref);
    const el = entry?.el.deref();
    if (entry !== undefined && el !== undefined && live(el, entry.frames)) return found(el, entry.frames);
    if (op.match === undefined) {
      const status = entry !== undefined || op.ref < reg.next ? "gone" : "unknown";
      return { kind: "resolve", next: reg.next, result: { status } };
    }
  }

  const nearOf = (words: string[]): El[] => {
    const out: El[] = [];
    if (words.length === 0) return out;
    for (const it of ordered(candidates())) {
      const names = namesOf(it.el);
      const hay = `${names.join(" ")} ${it.el.getAttribute("data-testid") ?? ""} ${it.el.id}`.toLowerCase();
      if (!words.some((w) => hay.includes(w))) continue;
      out.push(toEl(it, names[0] ?? ""));
      if (out.length >= 5) break;
    }
    return out;
  };

  const match = op.match;
  if (match === undefined) {
    return { kind: "resolve", next: reg.next, result: { status: "none", near: nearOf(op.near ?? []) } };
  }

  // Tiers: exact (case-sensitive, then not) > prefix > substring; at each
  // level an accessible name beats an element's own text.
  const needle = squash(match.text ?? "");
  const lower = needle.toLowerCase();
  const level = (s: string): number => {
    if (s === needle) return 4;
    const l = s.toLowerCase();
    if (l === lower) return 3;
    if (match.exact) return 0;
    if (l.startsWith(lower)) return 2;
    return l.includes(lower) ? 1 : 0;
  };
  const NAME_TIER = [0, 2, 4, 7, 8];
  const TEXT_TIER = [0, 1, 3, 5, 6];
  const best = (names: string[]): number => {
    let top = 0;
    for (const n of names) top = Math.max(top, level(n));
    return top;
  };

  const tiers = new Map<Element, { tier: number; root: Root }>();
  const offer = (el: Element, root: Root, tier: number): void => {
    if (tier <= 0) return;
    const known = tiers.get(el);
    if (known === undefined || known.tier < tier) tiers.set(el, { tier, root });
  };

  for (const root of roots) {
    if (match.kind === "testid") {
      for (const el of Array.from(root.node.querySelectorAll("[data-testid]"))) {
        offer(el, root, NAME_TIER[level(el.getAttribute("data-testid") ?? "")] ?? 0);
      }
    } else if (match.kind === "label") {
      for (const el of Array.from(root.node.querySelectorAll(CANDIDATES))) {
        offer(el, root, NAME_TIER[best(labelsOf(el))] ?? 0);
      }
    } else if (match.kind === "role") {
      const implicit = IMPLICIT_ROLE[match.role];
      const selector = implicit ? `[role="${CSS.escape(match.role)}"], ${implicit}` : `[role="${CSS.escape(match.role)}"]`;
      for (const el of Array.from(root.node.querySelectorAll(selector))) {
        if (roleOf(el) !== match.role) continue;
        offer(el, root, needle ? (NAME_TIER[best(namesOf(el))] ?? 0) : 8);
      }
    } else {
      for (const el of Array.from(root.node.querySelectorAll(CANDIDATES))) {
        const names = namesOf(el);
        const testid = el.getAttribute("data-testid");
        if (testid) names.push(testid);
        offer(el, root, NAME_TIER[best(names)] ?? 0);
      }
      // Any element's own text, unless an interactive ancestor already answers for it.
      const owner: Document = isShadow(root.node) ? root.node.ownerDocument : root.node;
      const walker = owner.createTreeWalker(root.node, 4); // NodeFilter.SHOW_TEXT
      const seen = new Set<Element>();
      for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
        const parent = t.parentElement;
        if (parent === null || seen.has(parent)) continue;
        if (!(t.nodeValue ?? "").trim()) continue;
        seen.add(parent);
        if (SKIP_TEXT.has(parent.localName) || parent.closest(CONTENT_NAMED) !== null) continue;
        offer(parent, root, TEXT_TIER[level(textIn(parent, false))] ?? 0);
      }
    }
  }

  const scored: Scored[] = [];
  for (const [el, { tier, root }] of tiers) {
    const it = itemOf(el, root);
    if (it === null) continue;
    // A dialog's own elements outrank the page behind it; the page is tried
    // only when nothing in the dialog matches.
    const placement = it.inDialog ? 2 : it.inView ? 1 : 0;
    scored.push({ ...it, score: tier * 10 + placement });
  }
  const pool = scope !== null && scored.some((s) => s.inDialog) ? scored.filter((s) => s.inDialog) : scored;
  if (pool.length === 0) {
    return { kind: "resolve", next: reg.next, result: { status: "none", near: nearOf(op.near ?? []) } };
  }
  let top = 0;
  for (const s of pool) top = Math.max(top, s.score);
  // Nested ties are one target: keep the innermost.
  const tied = pool
    .filter((s) => s.score === top)
    .filter((s, _, all) => !all.some((o) => o !== s && composedContains(s.el, o.el)));
  const winner = tied[0];
  if (winner !== undefined && (tied.length === 1 || op.first)) return found(winner.el, frameIdsOf(winner.root));
  return {
    kind: "resolve",
    next: reg.next,
    result: { status: "ambiguous", tied: tied.slice(0, 10).map((s) => toEl(s, namesOf(s.el)[0] ?? "")) },
  };
}

// ---------------------------------------------------------------------------
// Rendering (daemon side)
// ---------------------------------------------------------------------------

function renderLine(el: El): string {
  const label = el.name ? `"${el.name}"` : el.testid ? `{${el.testid}}` : el.id ? `#${el.id}` : `<${el.tag}>`;
  const marks = [...el.state];
  if (el.dialog) marks.push("dialog");
  if (el.frame !== undefined) marks.push(`frame "${el.frame}"`);
  const suffix = marks.length > 0 ? ` (${marks.join(", ")})` : "";
  return `[${el.ref}] ${el.role} ${label}${suffix}`;
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

export interface ElsDiff {
  added: number;
  removed: number[];
  changed: number;
}

/**
 * Budgets `els` (already ordered and filtered in-page) into the rendered list.
 * `total` is how many elements the listing could have shown; with a diff, the
 * list holds only added + changed and a summary line closes it.
 */
export function renderList(
  els: El[],
  total: number,
  opts: { all?: boolean; diff?: ElsDiff },
): Omit<ElsResult, "generation"> {
  const capped = opts.all || opts.diff ? els : els.slice(0, BUDGET.ELS_MAX_ELEMENTS);
  const reserve = opts.diff ? MORE_LINE_RESERVE : 0;
  let { kept, text } = fit(capped, BUDGET.ELS_MAX_CHARS - reserve);
  const known = Math.max(total, els.length);
  let truncated = kept.length < known;
  if (truncated) {
    // Re-fit leaving room for the trailing "+N more" line.
    ({ kept, text } = fit(capped, BUDGET.ELS_MAX_CHARS - reserve - MORE_LINE_RESERVE));
    truncated = kept.length < known;
  }
  const lines = text ? [text] : [];
  if (truncated) {
    const hint = opts.all ? "use --filter <text>" : "use --all or --filter <text>";
    lines.push(`(+${known - kept.length} more — ${hint})`);
  }
  if (opts.diff) {
    const { added, removed, changed } = opts.diff;
    if (added === 0 && changed === 0 && removed.length === 0) {
      lines.push("(no changes since the last scan)");
    } else {
      const gone = removed.length === 0 ? "" : `, removed ${removed.slice(0, 12).join(" ")}${removed.length > 12 ? " …" : ""}`;
      lines.push(`(diff: ${added} added, ${changed} changed, ${removed.length} removed${gone})`);
    }
  }
  const result: Omit<ElsResult, "generation"> = { els: kept, total: known, truncated, rendered: lines.join("\n") };
  if (opts.diff) result.diff = opts.diff;
  return result;
}

// ---------------------------------------------------------------------------
// LEGACY: the pre-C3 scan, kept only so session.ts compiles until core applies
// the resolve.ts wiring. Delete this whole section with that change.
// ---------------------------------------------------------------------------

const LEGACY_MORE_RESERVE = 64;

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

function legacyLine(el: El): string {
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

function legacyFit(els: El[], budget: number): { kept: El[]; text: string } {
  const kept: El[] = [];
  let length = 0;
  for (const el of els) {
    const line = legacyLine(el);
    const cost = kept.length === 0 ? line.length : line.length + 1;
    if (kept.length > 0 && length + cost > budget) break;
    kept.push(el);
    length += cost;
  }
  return { kept, text: kept.map(legacyLine).join("\n") };
}


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
  let { kept, text } = legacyFit(capped, BUDGET.ELS_MAX_CHARS);
  let truncated = kept.length < matched.length;
  if (truncated) {
    // Re-fit leaving room for the trailing "+N more" line.
    ({ kept, text } = legacyFit(capped, BUDGET.ELS_MAX_CHARS - LEGACY_MORE_RESERVE));
    truncated = kept.length < matched.length;
  }

  const hint = opts.all ? "use --filter <text>" : "use --all or --filter <text>";
  const rendered = truncated ? `${text}\n(+${matched.length - kept.length} more — ${hint})` : text;

  return { els: kept, total: scan.total, truncated, rendered };
}
