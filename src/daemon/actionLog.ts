// The daemon's action log: recording transcripts, flow synthesis and agent
// evidence all read it. It used to grow for the daemon's whole life; now it
// keeps the newest ACTION_LOG_CAP entries. Readers hold absolute indexes
// (`nextIndex`, `ActionLogEntry.index`), so trimming moves a base instead of
// renumbering, and an index from before a trim still reads what's left.
//
// Node runtime (like the rest of src/daemon): node:* only, no Bun.*.

import type { ActionLogEntry } from "../protocol.ts";

export const ACTION_LOG_CAP = 1000;
/** Trim in chunks, so a long session isn't a splice per command. */
const ACTION_LOG_SLACK = 200;

export class ActionLog {
  private readonly entries: ActionLogEntry[] = [];
  private base = 0;
  private hold: number | null = null;
  private readonly cap: number;
  private readonly slack: number;

  constructor(cap = ACTION_LOG_CAP, slack = ACTION_LOG_SLACK) {
    this.cap = cap;
    this.slack = slack;
  }

  /** The index the next entry gets. */
  get nextIndex(): number {
    return this.base + this.entries.length;
  }

  /** Entries kept right now. */
  get size(): number {
    return this.entries.length;
  }

  /** Entries trimmed over the daemon's life. */
  get dropped(): number {
    return this.base;
  }

  get chars(): number {
    let n = 0;
    for (const a of this.entries) n += a.text.length + a.cmdJson.length + (a.stableTarget?.length ?? 0);
    return n;
  }

  push(entry: Omit<ActionLogEntry, "index">): void {
    this.entries.push({ ...entry, index: this.nextIndex });
    this.trim();
  }

  /** Every kept entry at or after `index`. */
  since(index: number): ActionLogEntry[] {
    return this.entries.slice(Math.max(0, index - this.base));
  }

  /** Never trim `from` or anything after it, until released with null. A live recording holds its start. */
  holdFrom(from: number | null): void {
    this.hold = from;
  }

  private trim(): void {
    if (this.entries.length <= this.cap + this.slack) return;
    let drop = this.entries.length - this.cap;
    if (this.hold !== null) drop = Math.min(drop, Math.max(0, this.hold - this.base));
    if (drop <= 0) return;
    this.entries.splice(0, drop);
    this.base += drop;
  }
}
