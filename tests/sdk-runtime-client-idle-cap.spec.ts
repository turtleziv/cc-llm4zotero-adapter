import { describe, expect, it } from "vitest";

import { ClaudeAgentSdkRuntimeClient } from "../src/providers/claude-agent-sdk-runtime-client.js";

/**
 * Local patch (2026-09-06, see .local_patch_version): the runtime client owns
 * the idle sweeper. A warmed runtime the host never released must still be
 * closed once it has sat idle past the cap; an active conversation must not.
 */
function fakeQueryImpl(closed: string[], sessionId = "sess-idle") {
  return (args: Record<string, unknown>) => {
    const prompt = args.prompt as AsyncIterable<unknown>;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _message of prompt) {
          yield { type: "system", session_id: sessionId, subtype: "init" };
          yield { type: "result", session_id: sessionId, result: "ok", is_error: false };
        }
      },
      close() {
        closed.push(sessionId);
      },
    } as any;
  };
}

describe("ClaudeAgentSdkRuntimeClient hot runtime idle cap", () => {
  it("closes a warmed runtime the host never released once it is idle past the cap", async () => {
    const closed: string[] = [];
    const expired: Array<{ conversationKey: string; idleMs: number }> = [];
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl: fakeQueryImpl(closed),
      hotRuntimeMaxIdleMs: 60_000,
      hotRuntimeSweepIntervalMs: 0,
      onHotRuntimeExpired: (info) => expired.push({ conversationKey: info.conversationKey, idleMs: info.idleMs }),
    });
    await runtime.retainHotRuntime({ conversationKey: "conv-idle", userMessage: "" }, "mount-1");
    await runtime.warmHotRuntime({
      conversationKey: "conv-idle",
      userMessage: "",
      providerSessionId: "sess-idle",
    });
    const entry = (runtime as any).hotRuntimePool.get("conv-idle");
    expect(Boolean(entry?.query)).toBe(true);
    expect(entry.mounts.size).toBe(1);

    expect(runtime.sweepIdleHotRuntimes(entry.lastActivityAt + 59_999)).toEqual([]);
    expect(closed).toEqual([]);

    expect(runtime.sweepIdleHotRuntimes(entry.lastActivityAt + 60_000)).toEqual(["conv-idle"]);
    expect(closed).toEqual(["sess-idle"]);
    expect((runtime as any).hotRuntimePool.get("conv-idle")).toBeUndefined();
    expect(expired).toEqual([{ conversationKey: "conv-idle", idleMs: 60_000 }]);
  });

  it("a completed turn refreshes activity so an active conversation survives the sweep", async () => {
    const closed: string[] = [];
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl: fakeQueryImpl(closed, "sess-active"),
      hotRuntimeMaxIdleMs: 60_000,
      hotRuntimeSweepIntervalMs: 0,
    });
    await runtime.retainHotRuntime({ conversationKey: "conv-active", userMessage: "" }, "mount-1");
    const entry = (runtime as any).hotRuntimePool.get("conv-active");
    entry.lastActivityAt = 1_000;

    const turn = await runtime.startTurn({
      conversationKey: "conv-active",
      userMessage: "hello",
      providerSessionId: "sess-active",
    });
    for await (const _event of turn.events) {
      void _event;
    }

    const afterTurn = (runtime as any).hotRuntimePool.get("conv-active");
    expect(afterTurn).toBeDefined();
    expect(afterTurn.lastActivityAt).toBeGreaterThan(1_000);
    expect(runtime.sweepIdleHotRuntimes(afterTurn.lastActivityAt + 59_999)).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("does not start a sweeper when the cap is disabled", () => {
    const runtime = new ClaudeAgentSdkRuntimeClient({
      queryImpl: fakeQueryImpl([]),
      hotRuntimeMaxIdleMs: 0,
    });
    expect((runtime as any).hotRuntimePool.isSweeping()).toBe(false);
    runtime.stopHotRuntimeSweeper();
  });
});
