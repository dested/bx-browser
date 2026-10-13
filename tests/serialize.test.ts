// js support (A1), no browser: the in-page serializer runs in a fresh node:vm
// realm (the way it runs in a page: as source, against that realm's builtins),
// and the statement rewrite is checked by actually running what it produces.
//
//   bun test tests/serialize.test.ts

import { describe, expect, test } from "bun:test";
import vm from "node:vm";

import {
  SERIALIZER_SOURCE,
  jsFunctionSource,
  jsProgram,
  lastStatementStart,
} from "../src/daemon/serialize.ts";

const MAX = 4000;

// Just enough DOM for the serializer's instanceof checks.
const FAKE_DOM = `
  class Node {
    constructor(nodeType, nodeName, text) { this.nodeType = nodeType; this.nodeName = nodeName; this.textContent = text; }
  }
  class Element extends Node {
    constructor(tag, attrs, text) { super(1, tag.toUpperCase(), text); this.tagName = tag.toUpperCase(); this.attrs = attrs; this.id = attrs.id ?? ""; }
    getAttribute(name) { return this.attrs[name] ?? null; }
  }
`;

/** Serialize the value `setup` builds, inside a fresh realm. */
function ser(setup: string, maxChars = MAX): { json: string; truncated: boolean } {
  const out: unknown = vm.runInNewContext(
    `${FAKE_DOM}; (${SERIALIZER_SOURCE})((() => { ${setup} })(), ${maxChars})`,
  );
  if (typeof out !== "object" || out === null || !("json" in out) || !("truncated" in out)) {
    throw new Error("serializer returned no result");
  }
  const { json, truncated } = out;
  if (typeof json !== "string" || typeof truncated !== "boolean") throw new Error("bad result shape");
  return { json, truncated };
}

function parsed(setup: string, maxChars = MAX): unknown {
  const { json } = ser(setup, maxChars);
  expect(json.length).toBeLessThanOrEqual(maxChars);
  return JSON.parse(json);
}

/** Run what `js` would run, minus the page: the caller's text as a function. */
async function run(text: string): Promise<unknown> {
  const fn: unknown = vm.runInNewContext(jsFunctionSource(text));
  if (typeof fn !== "function") throw new Error("not a function");
  const result: unknown = await fn();
  return result;
}

describe("serializer", () => {
  test("DOM element → tag#id.class \"name\"", () => {
    expect(
      parsed(`return new Element("button", { id: "save", class: "btn primary extra" }, "  Save \\n changes ");`),
    ).toBe('<button#save.btn.primary "Save changes">');
    expect(parsed(`return new Element("a", { "aria-label": "Home" }, "ignored");`)).toBe('<a "Home">');
    expect(parsed(`return [new Element("input", { id: "pw" }, "")];`)).toEqual(["<input#pw>"]);
  });

  test("Map and Set become entries", () => {
    expect(parsed(`return new Map([["a", 1], ["b", { c: 2 }]]);`)).toEqual({ __map: [["a", 1], ["b", { c: 2 }]] });
    expect(parsed(`return new Set([1, 2, 3]);`)).toEqual({ __set: [1, 2, 3] });
  });

  test("cycles, BigInt, functions, undefined", () => {
    expect(parsed(`const o = { name: "o" }; o.self = o; return o;`)).toEqual({ name: "o", self: "[Circular]" });
    expect(parsed(`return 123n;`)).toBe("123n");
    expect(parsed(`return [function named() {}, () => 1];`)).toEqual(["[Function named]", "[Function anonymous]"]);
    expect(parsed(`return [1, undefined, 3];`)).toEqual([1, null, 3]);
    expect(parsed(`return { a: 1, b: undefined };`)).toEqual({ a: 1 });
    expect(ser(`return undefined;`).json).toBe("undefined");
  });

  test("a shared, non-cyclic reference is written out twice", () => {
    expect(parsed(`const s = { x: 1 }; return [s, s];`)).toEqual([{ x: 1 }, { x: 1 }]);
  });

  test("depth beyond 8 → [Depth]", () => {
    const json = ser(`let v = 0; for (let i = 0; i < 12; i++) v = { v }; return v;`).json;
    expect(json).toContain('"[Depth]"');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test("5,000-item array: first items, then a count, valid JSON", () => {
    const r = ser(`return Array.from({ length: 5000 }, (_, i) => i);`);
    expect(r.truncated).toBe(true);
    expect(r.json.length).toBeLessThanOrEqual(MAX);
    const arr: unknown = JSON.parse(r.json);
    if (!Array.isArray(arr)) throw new Error("not an array");
    expect(arr[0]).toBe(0);
    const last: unknown = arr[arr.length - 1];
    expect(last).toBe(`… ${5000 - (arr.length - 1)} more`);
  });

  test("long strings are cut with … and objects keep their first keys", () => {
    const s = ser(`return "x".repeat(10000);`);
    expect(s.truncated).toBe(true);
    expect(s.json.length).toBeLessThanOrEqual(MAX);
    const text: unknown = JSON.parse(s.json);
    expect(typeof text === "string" && text.endsWith("…")).toBe(true);

    const o = parsed(`const o = {}; for (let i = 0; i < 2000; i++) o["key" + i] = i; return o;`);
    if (typeof o !== "object" || o === null) throw new Error("not an object");
    expect(Object.keys(o)[0]).toBe("key0");
    expect(Object.entries(o).at(-1)?.[0]).toBe("…");
  });

  test("never exceeds the budget and always parses (fuzz)", () => {
    // Deterministic nested junk: arrays, objects, Maps, long strings, cycles.
    const build = `
      let seed = 7;
      const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      const make = (d) => {
        const r = rnd();
        if (d > 5 || r < 0.25) return r < 0.1 ? "s\\"q\\\\".repeat(Math.floor(rnd() * 60)) : Math.floor(rnd() * 1e6);
        if (r < 0.5) return Array.from({ length: Math.floor(rnd() * 30) }, () => make(d + 1));
        if (r < 0.6) return new Map([[make(d + 1), make(d + 1)]]);
        const o = {}; const n = Math.floor(rnd() * 12);
        for (let i = 0; i < n; i++) o["k" + i + "\\u00e9"] = make(d + 1);
        if (rnd() < 0.2) o.loop = o;
        return o;
      };
      return Array.from({ length: 20 }, () => make(0));
    `;
    for (const budget of [40, 64, 100, 257, 1000, 4000]) {
      const { json } = ser(build, budget);
      expect(json.length).toBeLessThanOrEqual(budget);
      expect(() => JSON.parse(json)).not.toThrow();
    }
  });
});

describe("statement rewrite", () => {
  test("expressions run as before", async () => {
    expect(await run("1 + 1")).toBe(2);
    expect(await run("({ a: 1 })")).toEqual({ a: 1 });
    expect(await run("{ a: 1 }")).toEqual({ a: 1 });
    expect(await run("await Promise.resolve(5)")).toBe(5);
  });

  test("statements return the last expression statement", async () => {
    expect(await run("const a = 2; a * 21")).toBe(42);
    expect(await run("let x = 1\nx + 1")).toBe(2);
    expect(await run("const a = [1, 2];\na.length;")).toBe(2);
    expect(await run("const s = 'a;b\\nc'; s.length")).toBe(5);
    expect(await run("const t = `x${[1, 2].join(';')}y`; t")).toBe("x1;2y");
    expect(await run("let n = 0\nfor (const i of [1, 2, 3]) { n += i }\nn")).toBe(6);
    expect(await run("const v = 3\nv // the answer")).toBe(3);
    expect(await run("const v = 4\nv\n// trailing note\n")).toBe(4);
  });

  test("a continued chain falls back to the last ; split", async () => {
    expect(await run("const a = [3, 1, 2];\na\n  .sort()\n  .join(',')")).toBe("1,2,3");
  });

  test("statements with no trailing expression return undefined", async () => {
    expect(await run("for (let i = 0; i < 3; i++) {}")).toBeUndefined();
    expect(await run("if (true) { 5 } else { 6 }")).toBeUndefined();
    expect(await run("const a = 1;")).toBeUndefined();
  });

  test("text that never compiles goes through as an expression", () => {
    expect(jsFunctionSource("1 +")).toBe("(async () => (1 +\n))");
  });

  test("lastStatementStart skips strings, comments and brackets", () => {
    expect(lastStatementStart("a; b", true)).toBe(3);
    expect(lastStatementStart("f(a;\nb)", true)).toBe(0);
    expect(lastStatementStart("'x;y'", true)).toBe(0);
    expect(lastStatementStart("a /* ; */ + b", false)).toBe(0);
    expect(lastStatementStart("// only a comment", true)).toBe(-1);
  });

  test("jsProgram evaluates end to end", async () => {
    const out: unknown = await vm.runInNewContext(jsProgram("const m = new Map([[1, 2]]); m", MAX));
    expect(out).toEqual({ json: '{"__map":[[1,2]]}', truncated: false });
  });
});
