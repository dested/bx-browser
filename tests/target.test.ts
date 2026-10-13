import { describe, expect, test } from "bun:test";
import { CliError, parseTarget } from "../src/client.ts";

describe("parseTarget", () => {
  test("refs: @N always, bare digits with a text fallback", () => {
    expect(parseTarget("@12")).toEqual({ ref: 12 });
    expect(parseTarget("2")).toEqual({ ref: 2, orText: "2" });
  });

  test("prefixes name the kind and carry --exact / --first", () => {
    expect(parseTarget("text:Save")).toEqual({ text: "Save" });
    expect(parseTarget("testid:save-btn", { exact: true })).toEqual({ testid: "save-btn", exact: true });
    expect(parseTarget("label:Email")).toEqual({ label: "Email" });
    expect(parseTarget("role:button")).toEqual({ role: "button" });
    expect(parseTarget("role:button:Save draft", { first: true })).toEqual({
      role: "button",
      name: "Save draft",
      first: true,
    });
    // A colon inside the name survives.
    expect(parseTarget("role:link:Docs: API")).toEqual({ role: "link", name: "Docs: API" });
  });

  test("selectors stay selectors; match options never attach to them or refs", () => {
    expect(parseTarget("#save", { exact: true })).toEqual({ selector: "#save" });
    expect(parseTarget("@3", { first: true })).toEqual({ ref: 3 });
  });

  test("plain text, with options", () => {
    expect(parseTarget("Save")).toEqual({ text: "Save" });
    expect(parseTarget("Save", { exact: true, first: false })).toEqual({ text: "Save", exact: true });
  });

  test("empty prefixes and bad roles are usage errors", () => {
    expect(() => parseTarget("text:")).toThrow(CliError);
    expect(() => parseTarget("role:Button!")).toThrow(CliError);
  });
});
