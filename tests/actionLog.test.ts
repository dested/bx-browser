// The capped action log (daemon/actionLog.ts): absolute indexes survive trims,
// and a held recording start is never trimmed. No browser.
import { describe, expect, test } from "bun:test";
import { ActionLog } from "../src/daemon/actionLog.ts";

function fill(log: ActionLog, n: number): void {
  for (let i = 0; i < n; i++) log.push({ t: i, cmd: "click", text: `clicked ${log.nextIndex}`, cmdJson: "{}" });
}

describe("ActionLog", () => {
  test("keeps the newest cap entries, trimming in chunks", () => {
    const log = new ActionLog(10, 5);
    fill(log, 15);
    expect(log.size).toBe(15); // within cap + slack
    fill(log, 1);
    expect(log.size).toBe(10);
    expect(log.dropped).toBe(6);
    expect(log.nextIndex).toBe(16);
  });

  test("indexes stay absolute across trims", () => {
    const log = new ActionLog(10, 5);
    fill(log, 40);
    const all = log.since(0);
    expect(all[0]?.index).toBe(log.dropped);
    expect(all.at(-1)?.index).toBe(39);
    expect(all.at(-1)?.text).toBe("clicked 39");
    expect(log.since(37).map((e) => e.index)).toEqual([37, 38, 39]);
    expect(log.since(40)).toEqual([]);
  });

  test("an index from before a trim reads what's left", () => {
    const log = new ActionLog(10, 5);
    const start = log.nextIndex;
    fill(log, 40);
    expect(log.since(start).length).toBe(log.size);
  });

  test("a hold keeps everything from its index until released", () => {
    const log = new ActionLog(10, 5);
    fill(log, 5);
    const start = log.nextIndex;
    log.holdFrom(start);
    fill(log, 50);
    const take = log.since(start);
    expect(take.length).toBe(50);
    expect(take[0]?.index).toBe(start);
    log.holdFrom(null);
    fill(log, 1);
    expect(log.size).toBe(10);
  });
});
