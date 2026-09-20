import { describe, expect, it } from "bun:test";
import { BoxComputeClient } from "../src/client.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

describe("BoxCompute client", () => {
  it("creates and revokes service access without retrying or leaking operation ids into the body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const generation = "87654321-1234-4123-8123-123456789abc";
    const request = {
      operation_id: "12345678-1234-4123-8123-123456789abc",
      requested_at: Math.floor(Date.now() / 1_000) - 1,
      client_key: `nodekey:${"a".repeat(64)}`,
      recipient_key: Buffer.alloc(32, 2).toString("base64"),
      ports: [3000],
    };
    const envelope = { generation_id: generation, expires_at: request.requested_at + 300,
      sealed: Buffer.alloc(96, 4).toString("base64") };
    const client = new BoxComputeClient({
      url: "https://app.boxcompute.ai",
      token: "bc_live_secret",
      tokenFile: "/credential",
    }, (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return json(init?.method === "DELETE"
        ? { generation_id: generation, cleanup: "untrusted-guest-report" }
        : envelope, init?.method === "DELETE" ? 200 : 201);
    }) as typeof globalThis.fetch);

    expect(await client.createServiceAccess("sbx_one", request)).toEqual(envelope);
    expect(await client.revokeServiceAccess("sbx_one", generation)).toBe("untrusted-guest-report");
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init?.headers).get("idempotency-key")).toBe(request.operation_id);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      requested_at: request.requested_at,
      client_key: request.client_key,
      recipient_key: request.recipient_key,
      ports: request.ports,
    });
    expect(calls[1]!.url).toEndWith(`/services/${generation}`);
  });

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

  it("forwards an optional scheduler CPU allocation when starting a sandbox", async () => {
    const bodies: unknown[] = [];
    const client = new BoxComputeClient({
      url: "https://app.boxcompute.ai",
      token: "bc_live_secret",
      tokenFile: "/credential",
    }, (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ sandbox: {} }, 201);
    }) as typeof globalThis.fetch);

    await client.start("workspace-default");
    await client.start("workspace-sized", { cpu: 0.5 });

    expect(bodies).toEqual([
      { workspaceId: "workspace-default" },
      { workspaceId: "workspace-sized", cpu: 0.5 },
    ]);
  });

  it("sends VM size and omits it for gVisor", async () => {
    const bodies: unknown[] = [];
    const client = new BoxComputeClient({
      url: "https://app.boxcompute.ai",
      token: "bc_live_secret",
      tokenFile: "/credential",
    }, (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ sandbox: { vmSandbox: true } }, 201);
    }) as typeof globalThis.fetch);

    await client.start("workspace-vm", { vmSandbox: true, size: "small", idempotencyKey: "key-one" });
    await client.start("workspace-vm", { vmSandbox: true, size: "large", idempotencyKey: "key-two" });
    await client.start("workspace-vm", { gvisor: true, size: "small" });

    expect(bodies).toEqual([
      { workspaceId: "workspace-vm", vmSandbox: true, size: "small" },
      { workspaceId: "workspace-vm", vmSandbox: true, size: "large" },
      { workspaceId: "workspace-vm", vmSandbox: false },
    ]);
  });

  it("rejects large VM sizing on the gVisor runtime", async () => {
    const client = new BoxComputeClient({
      url: "https://app.boxcompute.ai",
      token: "bc_live_secret",
      tokenFile: "/credential",
    }, (async () => { throw new Error("should not fetch"); }) as unknown as typeof globalThis.fetch);

    await expect(client.start("workspace-one", { gvisor: true, size: "large" }))
      .rejects.toThrow("--size large is VM only");
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
});
