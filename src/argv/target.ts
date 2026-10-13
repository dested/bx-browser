// Target strings → Target. Shared by the CLI, the daemon's /argv route, flows
// and the agent tools.

import type { Target } from "../protocol.ts";
import { CliError } from "./errors.ts";

const SELECTOR_PREFIXES = ["#", ".", "[", "//", "css=", "xpath="];

export function isSelectorLike(s: string): boolean {
  return SELECTOR_PREFIXES.some((prefix) => s.startsWith(prefix));
}

/** `--exact` / `--first`, applied to text, testid, label and role targets. */
export interface MatchOpts {
  exact?: boolean;
  first?: boolean;
}

const ROLE_TARGET = /^role:([a-z]+)(?::(.*))?$/;

function prefixed(s: string, prefix: string): string | undefined {
  if (!s.startsWith(prefix)) return undefined;
  const rest = s.slice(prefix.length);
  if (rest.length === 0) throw new CliError(2, `${prefix} needs a value, e.g. ${prefix}Save`);
  return rest;
}

/**
 * `@12` is a ref. Bare digits ("2") could be a ref or a button labelled 2, so
 * they go as {ref, orText} and the daemon uses the ref only when it is live in
 * the page's registry. `text:`, `testid:`, `label:` and `role:<role>[:<name>]`
 * name the kind outright. Selector-looking strings are selectors; the rest is text.
 */
export function parseTarget(s: string, match: MatchOpts = {}): Target {
  const at = /^@(\d+)$/.exec(s);
  if (at?.[1] !== undefined) return { ref: Number(at[1]) };
  if (/^\d+$/.test(s)) return { ref: Number(s), orText: s };
  const m = {
    ...(match.exact === true ? { exact: true } : {}),
    ...(match.first === true ? { first: true } : {}),
  };
  const text = prefixed(s, "text:");
  if (text !== undefined) return { text, ...m };
  const testid = prefixed(s, "testid:");
  if (testid !== undefined) return { testid, ...m };
  const label = prefixed(s, "label:");
  if (label !== undefined) return { label, ...m };
  if (s.startsWith("role:")) {
    const role = ROLE_TARGET.exec(s);
    if (role?.[1] === undefined) {
      throw new CliError(2, `bad role target "${s}" — use role:button or role:button:Save`);
    }
    const name = role[2];
    return name === undefined || name === "" ? { role: role[1], ...m } : { role: role[1], name, ...m };
  }
  if (isSelectorLike(s)) return { selector: s };
  return { text: s, ...m };
}
