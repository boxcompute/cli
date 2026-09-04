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
      image: null,
      createdAt: 1,
      lastUsedAt: 2,
    };
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/v1/sandboxes") && init?.method === "POST") return json({ sandbox }, 201);
      if (url.endsWith("/api/v1/sandboxes")) return json({ sandboxes: [sandbox] });
      if (url.endsWith("/execute")) return json({ result: { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false, wallTimeSeconds: 0.1 } });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ sandbox });
    }) as typeof globalThis.fetch;
    const client = new BoxComputeClient({
      url: "https://app.boxcompute.ai",
      token: "bc_live_secret",
      tokenFile: "/credential",
    }, fetch);

    expect(await client.list()).toEqual([sandbox]);
    expect(await client.start("workspace-one")).toEqual(sandbox);
    expect((await client.execute("workspace-one", { argv: ["printf", "ok\\n"] })).stdout).toBe("ok\n");
    await client.delete("workspace-one");
    await client.logout();

    expect(calls).toHaveLength(5);
    expect(calls.every((call) => new Headers(call.init?.headers).get("authorization") === "Bearer bc_live_secret")).toBe(true);
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ workspaceId: "workspace-one" });
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ argv: ["printf", "ok\\n"] });
    expect(calls[4]!.url).toEndWith("/api/v1/auth");
  });
});
