// `js` support (A1): what runs in the page, and how the caller's text becomes
// a function. The serializer is shipped to the page as source, so it must stay
// self-contained: no references to anything outside its own body.

/**
 * In-page: `value` as JSON of at most `maxChars` characters, always parseable.
 * DOM nodes, Map, Set, cycles, BigInt and functions get readable stand-ins;
 * truncation is structural (first items, then a "… k more" marker) rather
 * than a cut through the middle of the text. Top-level undefined stays the
 * bare word `undefined`, as `js` has always reported it.
 */
export function serialize(value: unknown, maxChars: number): { json: string; truncated: boolean } {
  const MAX_DEPTH = 8;
  // Room kept for a trailing `,"… 1234567 more"` while items are still coming.
  const MORE_RESERVE = 24;
  const ancestors: object[] = [];
  let truncated = false;

  function atom(text: string, budget: number): string | null {
    return text.length <= budget ? text : null;
  }

  function str(s: string, budget: number): string | null {
    const whole = JSON.stringify(s);
    if (whole.length <= budget) return whole;
    if (budget < 3) return null;
    truncated = true;
    let n = Math.min(s.length, budget);
    for (;;) {
      const cut = JSON.stringify(`${s.slice(0, n)}…`);
      if (cut.length <= budget) return cut;
      if (n === 0) return null;
      n = Math.max(0, n - Math.max(1, cut.length - budget));
    }
  }

  /** Objects that read best as one descriptive string. */
  function label(v: object): string | null {
    if (typeof Element !== "undefined" && v instanceof Element) {
      const id = v.id ? `#${v.id}` : "";
      const classes = (v.getAttribute("class") ?? "")
        .trim()
        .split(/\s+/)
        .filter((c) => c !== "")
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join("");
      const name = (v.getAttribute("aria-label") || v.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `<${v.tagName.toLowerCase()}${id}${classes}${name ? ` "${name}"` : ""}>`;
    }
    if (typeof Node !== "undefined" && v instanceof Node) {
      if (v.nodeType === 3) return `#text "${(v.textContent ?? "").trim().slice(0, 40)}"`;
      return `[${v.nodeName}]`;
    }
    if (typeof Window !== "undefined" && v instanceof Window) return "[Window]";
    if (typeof URL !== "undefined" && v instanceof URL) return v.href;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (v instanceof Promise) return "[Promise]";
    if (v instanceof WeakMap) return "[WeakMap]";
    if (v instanceof WeakSet) return "[WeakSet]";
    return null;
  }

  function list(items: ArrayLike<unknown>, budget: number, depth: number): string | null {
    const n = items.length;
    let out = "[";
    let i = 0;
    for (; i < n; i++) {
      const sep = i === 0 ? "" : ",";
      const reserve = i < n - 1 ? MORE_RESERVE : 0;
      const room = budget - out.length - sep.length - 1 - reserve;
      const piece = room > 0 ? fit(items[i], room, depth + 1) : null;
      if (piece === null) break;
      out += sep + piece;
    }
    if (i < n) {
      truncated = true;
      out += `${i === 0 ? "" : ","}${JSON.stringify(`… ${n - i} more`)}`;
    }
    out += "]";
    return out.length <= budget ? out : null;
  }

  function entries(pairs: [string, unknown][], budget: number, depth: number): string | null {
    let out = "{";
    let written = 0;
    let i = 0;
    for (; i < pairs.length; i++) {
      const pair = pairs[i];
      if (!pair) break;
      const [key, val] = pair;
      // JSON drops undefined members.
      if (val === undefined) continue;
      const sep = written === 0 ? "" : ",";
      const prefix = `${JSON.stringify(key)}:`;
      const reserve = i < pairs.length - 1 ? MORE_RESERVE + 6 : 0;
      const room = budget - out.length - sep.length - prefix.length - 1 - reserve;
      const piece = room > 0 ? fit(val, room, depth + 1) : null;
      if (piece === null) break;
      out += sep + prefix + piece;
      written++;
    }
    if (i < pairs.length) {
      truncated = true;
      out += `${written === 0 ? "" : ","}"…":${JSON.stringify(`${pairs.length - i} more keys`)}`;
    }
    out += "}";
    return out.length <= budget ? out : null;
  }

  function fit(v: unknown, budget: number, depth: number): string | null {
    if (v === null || v === undefined) return atom("null", budget);
    if (typeof v === "string") return str(v, budget);
    if (typeof v === "number") return Number.isFinite(v) ? atom(String(v), budget) : str(String(v), budget);
    if (typeof v === "boolean") return atom(String(v), budget);
    if (typeof v === "bigint") return str(`${v}n`, budget);
    if (typeof v === "symbol") return str(v.toString(), budget);
    if (typeof v === "function") return str(`[Function ${v.name || "anonymous"}]`, budget);
    if (typeof v !== "object") return str(String(v), budget);
    if (ancestors.includes(v)) return str("[Circular]", budget);
    if (depth > MAX_DEPTH) return str("[Depth]", budget);
    const named = label(v);
    if (named !== null) return str(named, budget);
    ancestors.push(v);
    try {
      if (v instanceof Map) {
        return entries([["__map", Array.from(v, ([k, val]): unknown[] => [k, val])]], budget, depth);
      }
      if (v instanceof Set) return entries([["__set", Array.from(v)]], budget, depth);
      if (Array.isArray(v)) return list(v, budget, depth);
      if (typeof NodeList !== "undefined" && v instanceof NodeList) return list(Array.from(v), budget, depth);
      if (typeof HTMLCollection !== "undefined" && v instanceof HTMLCollection) {
        return list(Array.from(v), budget, depth);
      }
      let pairs: [string, unknown][];
      try {
        pairs = Object.entries(v);
      } catch {
        return str("[Unreadable]", budget);
      }
      return entries(pairs, budget, depth);
    } finally {
      ancestors.pop();
    }
  }

  if (value === undefined) return { json: "undefined", truncated: false };
  const json = fit(value, maxChars, 0) ?? JSON.stringify("…");
  return { json, truncated };
}

/** The serializer as page-side source: `(SERIALIZER_SOURCE)(value, maxChars)`. */
export const SERIALIZER_SOURCE: string = String(serialize);

/**
 * Parses without running: a Function constructor compiles its body eagerly
 * and throws SyntaxError (node:vm's Script does too under Node, but not under
 * Bun, where the tests run).
 */
function compiles(source: string): boolean {
  try {
    new Function(source);
    return true;
  } catch {
    return false;
  }
}

// A last statement that starts with one of these is not an expression; the
// function body then runs as written and yields undefined.
const STATEMENT_START =
  /^(?:const|let|var|if|for|while|do|switch|try|return|throw|function|class|import|export|break|continue|debugger)\b|^async\s+function\b|^[{;]/;

/**
 * Where the last top-level statement with code in it starts: just after the
 * last `;` (or newline, when `newlines`) outside strings, comments, templates
 * and brackets. A heuristic, not a parser; callers check the result compiles.
 */
export function lastStatementStart(body: string, newlines: boolean): number {
  type Mode = "code" | "single" | "double" | "template" | "line" | "block";
  const modes: Mode[] = ["code"];
  // Bracket depth per code level; a template's ${ opens a new code level.
  const depths: number[] = [0];
  let segmentStart = 0;
  let segmentHasCode = false;
  let lastWithCode = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const next = body[i + 1];
    const mode = modes[modes.length - 1];
    if (mode === "line") {
      if (ch === "\n") {
        modes.pop();
        i--; // let the code level see the newline
      }
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") {
        modes.pop();
        i++;
      }
      continue;
    }
    if (mode === "single" || mode === "double") {
      if (ch === "\\") i++;
      else if ((mode === "single" && ch === "'") || (mode === "double" && ch === '"')) modes.pop();
      continue;
    }
    if (mode === "template") {
      if (ch === "\\") i++;
      else if (ch === "`") modes.pop();
      else if (ch === "$" && next === "{") {
        modes.push("code");
        depths.push(0);
        i++;
      }
      continue;
    }
    // code
    const level = depths.length - 1;
    const depth = depths[level] ?? 0;
    if (ch === "/" && next === "/") {
      modes.push("line");
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      modes.push("block");
      i++;
      continue;
    }
    if (ch === "'") modes.push("single");
    else if (ch === '"') modes.push("double");
    else if (ch === "`") modes.push("template");
    else if (ch === "(" || ch === "[" || ch === "{") depths[level] = depth + 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0 && level > 0) {
        // closes a template's ${ … }
        modes.pop();
        depths.pop();
        continue;
      }
      depths[level] = Math.max(0, depth - 1);
    }
    const topLevel = level === 0 && depth === 0;
    if (topLevel && (ch === ";" || (newlines && ch === "\n"))) {
      if (segmentHasCode) lastWithCode = segmentStart;
      segmentStart = i + 1;
      segmentHasCode = false;
      continue;
    }
    if (ch !== undefined && !/\s/.test(ch)) segmentHasCode = true;
  }
  if (segmentHasCode) lastWithCode = segmentStart;
  if (lastWithCode < 0) return -1;
  // Skip leading whitespace so `return` lands on the code.
  let at = lastWithCode;
  while (at < body.length && /\s/.test(body[at] ?? "")) at++;
  return at;
}

/** `body` with `return ` before its last expression statement, or null. */
export function returningLast(body: string, newlines: boolean): string | null {
  const at = lastStatementStart(body, newlines);
  if (at < 0 || STATEMENT_START.test(body.slice(at))) return null;
  return `${body.slice(0, at)}return ${body.slice(at)}`;
}

/**
 * The caller's `js` text as an async function source, `(async () => …)`.
 * An expression comes back as is; statements run as a function body that
 * returns the last expression statement's value, REPL-style. Compiling (not
 * running) daemon-side decides which, so nothing runs in the page twice.
 * Text that compiles neither way goes through as an expression, so the page
 * reports its own SyntaxError.
 */
export function jsFunctionSource(text: string): string {
  const asExpression = `(async () => (${text}\n))`;
  if (compiles(asExpression)) return asExpression;
  for (const newlines of [true, false]) {
    const body = returningLast(text, newlines);
    if (body === null) continue;
    const source = `(async () => {\n${body}\n})`;
    if (compiles(source)) return source;
  }
  const asBody = `(async () => {\n${text}\n})`;
  return compiles(asBody) ? asBody : asExpression;
}

/**
 * K5: the SyntaxError message when `text` parses neither as an expression nor
 * as statements (compiled as an async function body, not run), else null.
 * Self-contained so the page can run it too: Node vets first, and the page
 * confirms, since its V8 may know syntax Node's does not. A compile the page
 * refuses for another reason (EvalError under a strict CSP) counts as "can't
 * tell": null.
 */
export function jsSyntaxError(text: string): string | null {
  const AsyncFunction: unknown = Object.getPrototypeOf(async () => undefined).constructor;
  if (typeof AsyncFunction !== "function") return null;
  const failure = (body: string): string | null => {
    try {
      Reflect.construct(AsyncFunction, [body]);
      return null;
    } catch (err) {
      return err instanceof SyntaxError ? err.message : null;
    }
  };
  if (failure(`return (${text}
);`) === null) return null;
  return failure(text);
}

/** Page-side program for `js`: run the caller's text, serialize what it produced. */
export function jsProgram(text: string, maxChars: number): string {
  return `(async () => { const __bxValue = await ${jsFunctionSource(text)}(); return (${SERIALIZER_SOURCE})(__bxValue, ${maxChars}); })()`;
}
