import { afterEach, describe, expect, it, vi } from "vitest";

import { createHotRuntimeTurn, HotRuntimePool } from "../src/providers/hotRuntimePool.js";

/**
 * Local patch (2026-09-06, see .local_patch_version): the pool used to close a
 * warm Claude runtime only after the host released every mount and a 5 minute
 * grace timer fired. A conversation the plugin never released (Zotero window
 * closed, plugin reloaded) therefore kept its claude.exe forever, and after a
 * week the bridge was carrying eight idle runtimes. These tests pin the
 * absolute idle cap that closes an entry no matter how many mounts it holds.
 */
describe("HotRuntimePool absolute idle cap", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps an entry that is still mounted once it has been idle past maxIdleMs", () => {
    const pool = new HotRuntimePool({ graceMs: 3000, maxIdleMs: 1000 });
    const entry = pool.retain("conv-a", "mount-1");
    entry.lastActivityAt = 10_000;
    const expired: string[] = [];
    const swept = pool.sweepIdle((e) => expired.push(e.conversationKey), 11_001);
    expect(swept.map((e) => e.conversationKey)).toEqual(["conv-a"]);
    expect(expired).toEqual(["conv-a"]);
    expect(pool.get("conv-a")).toBeUndefined();
  });

  it("keeps a mounted entry that was active within maxIdleMs", () => {
    const pool = new HotRuntimePool({ graceMs: 3000, maxIdleMs: 1000 });
    const entry = pool.retain("conv-a", "mount-1");
    entry.lastActivityAt = 10_000;
    const expired: string[] = [];
    expect(pool.sweepIdle((e) => expired.push(e.conversationKey), 10_999)).toEqual([]);
    expect(expired).toEqual([]);
    expect(pool.get("conv-a")).toBe(entry);
  });

  it("never sweeps an entry with a turn in flight", () => {
    const pool = new HotRuntimePool({ graceMs: 3000, maxIdleMs: 1000 });
    const entry = pool.retain("conv-a", "mount-1");
    entry.lastActivityAt = 0;
    entry.currentTurn = createHotRuntimeTurn("run-1");
    const expired: string[] = [];
    expect(pool.sweepIdle((e) => expired.push(e.conversationKey), 999_999)).toEqual([]);
    expect(expired).toEqual([]);
    expect(pool.get("conv-a")).toBe(entry);
  });

  it("touch() refreshes lastActivityAt so a busy conversation is not swept", () => {
    const pool = new HotRuntimePool({ graceMs: 3000, maxIdleMs: 1000 });
    const entry = pool.retain("conv-a", "mount-1");
    entry.lastActivityAt = 0;
    pool.touch(entry, 20_000);
    expect(entry.lastActivityAt).toBe(20_000);
    expect(pool.sweepIdle(() => undefined, 20_500)).toEqual([]);
    expect(pool.sweepIdle(() => undefined, 21_001).length).toBe(1);
  });

  it("maxIdleMs of 0 disables the cap", () => {
    const pool = new HotRuntimePool({ graceMs: 3000, maxIdleMs: 0 });
    const entry = pool.retain("conv-a", "mount-1");
    entry.lastActivityAt = 0;
    expect(pool.sweepIdle(() => undefined, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(pool.get("conv-a")).toBe(entry);
  });

  it("cancels a pending grace timer so the sweep fires onExpire exactly once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const pool = new HotRuntimePool({ graceMs: 3000, maxIdleMs: 1000 });
    const onExpire = vi.fn();
    pool.retain("conv-a", "mount-1");
    pool.release("conv-a", "mount-1", onExpire);
    const entry = pool.get("conv-a");
    expect(entry?.closeTimer).not.toBeNull();
    vi.setSystemTime(101_500);
    expect(pool.sweepIdle(onExpire).length).toBe(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("startSweeper runs the sweep on an interval and stopSweeper stops it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const pool = new HotRuntimePool({ graceMs: 3000, maxIdleMs: 1000 });
    const onExpire = vi.fn();
    pool.startSweeper(onExpire, 500);
    const entry = pool.retain("conv-a", "mount-1");
    entry.lastActivityAt = 98_000;
    vi.advanceTimersByTime(500);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(pool.get("conv-a")).toBeUndefined();
    pool.stopSweeper();
    const again = pool.retain("conv-b", "mount-1");
    again.lastActivityAt = 98_000;
    vi.advanceTimersByTime(5000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(pool.get("conv-b")).toBe(again);
  });
});
