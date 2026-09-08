import { describe, expect, it } from "vitest";

import { ClaudeAgentSdkRuntimeClient } from "../src/providers/claude-agent-sdk-runtime-client.js";

/**
 * Local patch (2026-09-08, see .local_patch_version): the bridge already passes
 * its own Zotero MCP server through `--mcp-config`, so every other MCP source
 * (the host's user-scope servers, project .mcp.json, plugins) is dead weight in
 * a Zotero conversation - each stdio server costs an npx + node pair per turn.
 * `strictMcpConfig` is a server-level switch: the frontend must not be able to
 * set it, so it is blocked as request metadata the same way `settingSources` is.
 */
function fakeQueryImpl() {
  return () =>
    ({
      async *[Symbol.asyncIterator]() {
        /* no messages needed - these tests only inspect the built options */
      },
      close() {},
    }) as any;
}

function buildOptions(
  client: ClaudeAgentSdkRuntimeClient,
  request: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (client as any).buildQueryOptions(request, metadata, undefined);
}

const BASE_REQUEST = { conversationKey: "conv-strict", userMessage: "hello" };

describe("strictMcpConfig", () => {
  it("reaches the SDK query options when the server opts in", async () => {
    const client = new ClaudeAgentSdkRuntimeClient({
      queryImpl: fakeQueryImpl(),
      strictMcpConfig: true,
    });
    const options = await buildOptions(client, BASE_REQUEST);
    expect(options.strictMcpConfig).toBe(true);
  });

  it("stays absent when the server does not opt in, so upstream behaviour is unchanged", async () => {
    const client = new ClaudeAgentSdkRuntimeClient({ queryImpl: fakeQueryImpl() });
    const options = await buildOptions(client, BASE_REQUEST);
    expect("strictMcpConfig" in options).toBe(false);
  });

  it("cannot be smuggled in through request metadata", async () => {
    const client = new ClaudeAgentSdkRuntimeClient({ queryImpl: fakeQueryImpl() });
    const options = await buildOptions(
      client,
      { ...BASE_REQUEST, metadata: { strictMcpConfig: true } },
      { strictMcpConfig: true },
    );
    expect("strictMcpConfig" in options).toBe(false);
  });

  it("keeps the explicitly passed Zotero MCP server alongside the strict switch", async () => {
    const client = new ClaudeAgentSdkRuntimeClient({
      queryImpl: fakeQueryImpl(),
      strictMcpConfig: true,
    });
    const options = await buildOptions(client, {
      ...BASE_REQUEST,
      mcpServers: {
        llm_for_zotero_profile_test: {
          type: "http",
          url: "http://127.0.0.1:23119/llm-for-zotero/mcp",
        },
      },
    });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toMatchObject({
      llm_for_zotero_profile_test: { type: "http" },
    });
  });
});
