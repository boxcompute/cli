import { describe, expect, it } from "bun:test";
import { BoxComputeClient } from "../src/client.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

describe("BoxCompute client", () => {
  it("uses the customer API with bearer authentication and structured commands", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sandbox = {
      id: "workspace-one",
      workspaceId: "workspace-one",
      name: "Demo",
      state: "running" as const,
      runtimeId: "runtime-one",
      retainedRuntimeId: null,
      image: null,
      createdAt: 1,
      lastUsedAt: 2,
    };
    const workspace = { id: "workspace-one", name: "Demo", createdAt: 1 };
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/v2/sandboxes") && init?.method === "POST") return json({ sandbox }, 201);
      if (url.endsWith("/api/v2/sandboxes")) return json({ sandboxes: [sandbox] });
      if (url.endsWith("/api/v2/workspaces")) return json({ workspaces: [workspace] });
      if (url.endsWith("/execute")) return json({ result: { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false, wallTimeSeconds: 0.1 } });
      if (url.includes("/logs?")) return json({ logs: {
        sandbox_id: "runtime-one",
        entries: [{
          timestamp: "2026-09-06T01:02:03.000Z",
          stream: "stderr",
          source: "process",
          message: "ready",
          pod_uid: "pod-one",
          process_id: "proc-one",
        }],
        truncated: false,
        retention_seconds: 2_592_000,
      } });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ sandbox });
    }) as typeof globalThis.fetch;
    const client = new BoxComputeClient({
      url: "https://app.boxcompute.ai",
      token: "bc_live_secret",
      tokenFile: "/credential",
    }, fetch);

    expect(await client.list()).toEqual([sandbox]);
    expect(await client.listWorkspaces()).toEqual([workspace]);
    expect(await client.start("workspace-one")).toEqual(sandbox);
    expect((await client.execute("workspace-one", { argv: ["printf", "ok\\n"] })).stdout).toBe("ok\n");
    expect((await client.logs("workspace-one", {
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-07T00:00:00.000Z",
      stream: "stderr",
      source: "process",
      limit: 25,
    })).entries[0]?.message).toBe("ready");
    await client.delete("workspace-one");
    await client.logout();

    expect(calls).toHaveLength(7);
    expect(calls.every((call) => new Headers(call.init?.headers).get("authorization") === "Bearer bc_live_secret")).toBe(true);
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ workspaceId: "workspace-one" });
    expect(JSON.parse(String(calls[3]!.init?.body))).toEqual({ argv: ["printf", "ok\\n"] });
    expect(calls[4]!.url).toContain("/api/v2/sandboxes/workspace-one/logs?");
    expect(calls[4]!.url).toContain("stream=stderr");
    expect(calls[4]!.url).toContain("source=process");
    expect(calls[4]!.url).toContain("limit=25");
    expect(calls[6]!.url).toEndWith("/api/v2/auth");
  });

  it("explains the server-first requirement when v2 is unavailable", async () => {
    const client = new BoxComputeClient({
      url: "https://old.boxcompute.example",
      token: "bc_live_secret",
      tokenFile: "/credential",
    }, (async () => json({ error: "not found" }, 404)) as unknown as typeof globalThis.fetch);

    await expect(client.list()).rejects.toThrow(
      "Upgrade the server before this CLI",
    );
  });

  it("uses the bounded public cooperative routes without retrying mutations", async () => {
    const endpointId = "12345678-1234-4234-8234-123456789abc";
    const envelope = {
      endpoint_id: endpointId,
      expires_at: Math.floor(Date.now() / 1_000) + 25,
      sealed: Buffer.alloc(96, 3).toString("base64"),
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return json(init?.method === "DELETE"
        ? { endpoint_id: endpointId, cleanup: "unconfirmed" }
        : envelope, init?.method === "DELETE" ? 202 : init?.method === "POST" ? 201 : 200);
    }) as typeof globalThis.fetch;
    const client = new BoxComputeClient({
      url: "https://app.boxcompute.ai",
      token: "bc_live_secret",
      tokenFile: "/credential",
    }, fetch);
    const keys = {
      client_key: `nodekey:${"a".repeat(64)}`,
      ssh_key: `ssh-ed25519 ${"A".repeat(68)}`,
      recipient_key: Buffer.alloc(32, 2).toString("base64"),
    };

    expect(await client.activateCooperativeConnection("sbx_demo", keys)).toEqual(envelope);
    expect(await client.reconnectCooperativeConnection("sbx_demo", endpointId, keys)).toEqual(envelope);
    await client.revokeCooperativeConnection("sbx_demo", endpointId);

    expect(calls.map((call) => call.url)).toEqual([
      "https://app.boxcompute.ai/api/v2/sandboxes/sbx_demo/cooperative-connection",
      `https://app.boxcompute.ai/api/v2/sandboxes/sbx_demo/cooperative-connection/${endpointId}`,
      `https://app.boxcompute.ai/api/v2/sandboxes/sbx_demo/cooperative-connection/${endpointId}`,
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual(["POST", "POST", "DELETE"]);
    expect(calls.every((call) => call.init?.redirect === "error")).toBe(true);
    expect(calls.every((call) => new Headers(call.init?.headers).get("authorization") === "Bearer bc_live_secret")).toBe(true);
  });

  it("rejects invalid cooperative inputs and responses without a second request", async () => {
    const fetch = (async () => json({ private: "unexpected" }, 503)) as unknown as typeof globalThis.fetch;
    const client = new BoxComputeClient({
      url: "https://app.boxcompute.ai",
      token: "bc_live_secret",
      tokenFile: "/credential",
    }, fetch);
    const keys = {
      client_key: `nodekey:${"a".repeat(64)}`,
      ssh_key: `ssh-ed25519 ${"A".repeat(68)}`,
      recipient_key: Buffer.alloc(32, 2).toString("base64"),
    };
    await expect(client.activateCooperativeConnection("runtime-internal", keys)).rejects.toThrow("unavailable");
    await expect(client.activateCooperativeConnection("sbx_demo", keys)).rejects.toThrow("unavailable");
  });
});
