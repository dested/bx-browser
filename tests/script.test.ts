import { expect, test } from "bun:test";
import { splitScript, splitWords } from "../src/script.ts";

test("splitScript: newlines always, semicolons only for bx do, quotes respected", () => {
  expect(splitScript("click Save\n# note\n\nwait text 'a;b'", false)).toEqual(["click Save", "wait text 'a;b'"]);
  expect(splitScript('click Save; wait text "Saved; ok"; els', true)).toEqual([
    "click Save",
    'wait text "Saved; ok"',
    "els",
  ]);
});

test("splitWords: shell-style quoting", () => {
  expect(splitWords(`fill "Email" 'a b'  plain`)).toEqual(["fill", "Email", "a b", "plain"]);
  expect(splitWords(`js "say \\"hi\\""`)).toEqual(["js", 'say "hi"']);
  expect(splitWords(`fill x ""`)).toEqual(["fill", "x", ""]);
  expect(() => splitWords(`click "open`)).toThrow();
});
