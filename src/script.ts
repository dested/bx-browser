// Batch scripts for `bx -` and `bx do`: split a script into command lines and
// each line into shell-style words. Pure functions, unit-tested in
// tests/script.test.ts.

import { CliError } from "./argv/errors.ts";

/**
 * Splits a script into command lines: newlines always separate commands, and
 * so does `;` in `bx do`. Separators inside quotes don't count. Blank lines and
 * `#` comments are dropped.
 */
export function splitScript(script: string, semicolons: boolean): string[] {
  const lines: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < script.length; i++) {
    const ch = script.charAt(i);
    if (quote !== null) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < script.length) {
        cur += script.charAt(i + 1);
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\n" || ch === "\r" || (semicolons && ch === ";")) {
      lines.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  lines.push(cur);
  return lines.map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** Shell-style words: single quotes are literal, double quotes allow \" and \\. */
export function splitWords(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && (line.charAt(i + 1) === '"' || line.charAt(i + 1) === "\\")) {
        cur += line.charAt(i + 1);
        i++;
      } else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
      continue;
    }
    cur += ch;
    inWord = true;
  }
  if (quote !== null) throw new CliError(2, `unterminated ${quote} in: ${line}`);
  if (inWord) words.push(cur);
  return words;
}
