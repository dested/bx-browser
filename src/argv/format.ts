// Human output for command results, shared by the CLI, the daemon's /argv
// route and the agent driver. Pure string building: no I/O.

import type {
  ActionResult,
  ConsoleEntry,
  El,
  ElsResult,
  NetEntry,
  PageInfo,
  StatusResult,
  TabsResult,
} from "../protocol.ts";

export function formatAction(verb: string, detail: string, r: ActionResult): string {
  const lines = [detail ? `✓ ${verb} ${detail}` : `✓ ${verb}`];
  if (r.navigated) lines.push(`→ ${r.page.url} — ${r.page.title}`);
  for (const text of r.consoleErrors) lines.push(`⚠ console: ${text}`);
  const d = r.delta;
  if (d) {
    if (!r.navigated && d.url !== undefined) lines.push(`→ ${d.url}`);
    if (!r.navigated && d.title !== undefined) lines.push(`title ${JSON.stringify(d.title)}`);
    if (d.dialog !== undefined) lines.push(`dialog ${d.dialog}`);
    for (const alert of d.alerts ?? []) lines.push(`! ${alert}`);
    if (d.added > 0 || d.removed > 0) lines.push(`dom +${d.added} −${d.removed}`);
    if (d.focused !== undefined) lines.push(`focus ${d.focused}`);
    if (d.newTab !== undefined) {
      lines.push(`new tab ${d.newTab.id}${d.newTab.active ? " (now active)" : " (background)"}: ${d.newTab.url}`);
    }
  }
  const then = r.then;
  if (then?.els) lines.push("", then.els.rendered.trim() || "(no interactive elements)");
  if (then?.text) lines.push("", then.text.truncated ? `${then.text.text}\n…(truncated)` : then.text.text);
  if (then?.snap) lines.push(`saved ${then.snap.path} (${then.snap.width}x${then.snap.height})`);
  return lines.join("\n");
}

function seconds(ms: number): string {
  return `+${(ms / 1000).toFixed(1)}s`;
}

export function formatConsoleEntry(e: ConsoleEntry): string {
  return `[${e.level}] ${seconds(e.t)} ${e.text}`;
}

// Loopback URLs are shown path-only; anything off-host keeps its origin so a
// stray third-party request is obvious.
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]") {
      return u.pathname + u.search;
    }
    return url;
  } catch {
    return url;
  }
}

export function formatNetEntry(e: NetEntry): string {
  const status = e.status === 0 ? "ERR" : String(e.status);
  const id = e.id === undefined ? "" : `#${e.id} `;
  return `${id}${e.method} ${status} ${Math.round(e.ms)}ms ${shortUrl(e.url)}`;
}

export function renderEl(el: El): string {
  const state = el.state.length > 0 ? ` (${el.state.join(", ")})` : "";
  return `[${el.ref}] ${el.role || el.tag} ${JSON.stringify(el.name)}${state}`;
}

export function renderPage(p: PageInfo): string {
  return `[${p.index}] ${p.active ? "*" : " "} ${p.title || "(untitled)"} — ${p.url}`;
}

// The tab verbs answer with the whole tab list, so confirm the change and then
// show the new state — that is what the next command needs to act on.
export function renderTabChange(verb: string, detail: string): (data: TabsResult) => string {
  return (data) => {
    const head = `✓ ${verb} ${detail}`.trimEnd();
    return data.pages.length === 0 ? head : `${head}\n${data.pages.map(renderPage).join("\n")}`;
  };
}

export function renderEls(data: ElsResult): string {
  const rendered = data.rendered.trim();
  const diff = data.diff;
  const head =
    diff === undefined
      ? undefined
      : `diff: +${diff.added} ~${diff.changed} −${diff.removed.length}` +
        (diff.removed.length > 0 ? ` (gone: ${diff.removed.map((r) => `@${r}`).join(" ")})` : "");
  let body: string;
  if (rendered.length === 0) body = head === undefined ? "(no interactive elements)" : "(nothing new)";
  else body = data.truncated ? `${rendered}\n…(${data.total} total, list truncated)` : rendered;
  return head === undefined ? body : `${head}\n${body}`;
}

export function renderEntries<T>(entries: T[], format: (entry: T) => string): string {
  if (entries.length === 0) return "(none)";
  return entries.map(format).join("\n");
}

function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

export function renderStatus(s: StatusResult): string {
  const lines = [
    `profile   ${s.profile}${s.headless ? " (headless)" : ""}`,
    `browser   ${s.browserRunning ? `running, up ${fmtDuration(s.uptimeMs)}` : "not running"}`,
    `recording ${s.recording ?? "none"}`,
    ...(s.relaunches > 0 ? [`relaunched ${s.relaunches}× after the browser closed`] : []),
    `tabs      ${s.pages.length}`,
  ];
  for (const page of s.pages) lines.push(`  ${renderPage(page)}`);
  return lines.join("\n");
}
