import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import { runCli } from "../src/cli.js";

const connection = { url: "https://app.boxcompute.ai", token: "bc_live_test", tokenFile: "/credential" };

function streams() {
  return { stdout: new PassThrough(), stderr: new PassThrough() };
}

function output(stream: PassThrough): string {
  let value = "";
  let chunk: Buffer | null;
  while ((chunk = stream.read() as Buffer | null) !== null) value += chunk.toString();
  return value;
}

/** Run one CLI command against a single canned API response and record the request. */
async function run(argv: string[], body: unknown, status = 200) {
  const io = streams();
  const requests: Array<{ url: URL; method: string; body: string | undefined }> = [];
  const code = await runCli(argv, {
    io,
    env: {},
    loadConnection: async () => connection,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: new URL(String(input)), method: init?.method ?? "GET", body: init?.body as string | undefined });
      return status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch,
  });
  return { code, requests, stdout: output(io.stdout), stderr: output(io.stderr) };
}

const costRun = { startedAt: 1_791_000_000_000, endedAt: 1_791_000_120_000, runtimeSeconds: 120, billableSeconds: 120, rateMicrosPerMinute: 1_500, amountMicros: 3_000 };
const costDetail = {
  sandbox: { sandboxId: "sbx_1", runs: 2, settledMicros: 3_000, estimatedMicros: 750 },
  runs: [costRun],
  running: [{ startedAt: 1_791_000_200_000, billableSeconds: 30, estimatedMicros: 750 }],
  truncated: false,
};

describe("API commands", () => {
  it("reads remaining credit and keeps settled spending separate from pending costs", async () => {
    const billing = {
      accountStatus: "active", modelBillingMode: "observe",
      balance: { totalMicros: 900_000, availableMicros: 800_000, reservedMicros: 25_000 },
      settledUsage: { aiMicros: 10_000, sandboxMicros: 90_000, totalMicros: 100_000 },
      activeEstimate: { status: "available", amountMicros: 75_000 },
    };
    const human = await run(["credits"], { billing });
    expect(human.requests[0]?.url.pathname).toBe("/api/v2/billing");
    expect(human.requests[0]?.method).toBe("GET");
    expect(human.stdout).toContain("Available credit\t$0.8000");
    expect(human.stdout).toContain("Settled spending\t$0.1000");
    const machine = await run(["--json", "billing"], { billing });
    expect(JSON.parse(machine.stdout)).toEqual({ billing });
    const unknown = await run(["credits"], { billing: { ...billing,
      balance: { ...billing.balance, availableMicros: null },
      activeEstimate: { status: "unavailable", amountMicros: null },
    } });
    expect(unknown.stdout).toContain("Available credit\tUnavailable");
    expect(unknown.stderr).toContain("spendable credit is unknown");
  });

  it("pages signed wallet transactions with filters and preserves exact JSON amounts", async () => {
    const page = { currency: "usd", nextCursor: "next_2", transactions: [{
      id: "entry_1", kind: "usage_charge", bucket: "promo", amountMicros: -2_034,
      description: "Compute\ncharge", createdAt: 1_000, expiresAt: null,
    }] };
    const result = await run(["billing", "transactions", "--bucket", "promo", "--kind", "usage_charge",
      "--before", "next_1", "--limit", "20", "--from", "2026-10-01T00:00:00Z"], page);
    expect(result.requests[0]?.url.pathname).toBe("/api/v2/billing/transactions");
    expect(Object.fromEntries(result.requests[0]!.url.searchParams)).toEqual({
      bucket: "promo", kind: "usage_charge", before: "next_1", limit: "20", from: "2026-10-01T00:00:00Z",
    });
    expect(result.stdout).toContain("-$0.0020\tCompute charge");
    expect(result.stderr).toContain("bxc billing transactions --before next_2");
    const json = await run(["--json", "billing", "transactions"], page);
    expect(JSON.parse(json.stdout)).toEqual(page);
    expect(json.stderr).toBe("");
  });

  it("reports activity counts and validates usage windows before a request", async () => {
    const usage = { since: 1_000, operations: 10, executions: 5, executionTimeMs: 1_234,
      outputBytes: 50, failedOperations: 1, agentRuns: 2, toolCalls: 7,
      activeSandboxes: 1, sandboxSlots: 2, recent: [] };
    const result = await run(["usage", "--days", "7"], { usage });
    expect(result.requests[0]?.url.pathname).toBe("/api/v2/usage");
    expect(result.requests[0]?.url.searchParams.get("days")).toBe("7");
    expect(result.stdout).toContain("Operations\t10");
    expect(JSON.parse((await run(["--json", "usage"], { usage })).stdout)).toEqual({ usage });
    for (const days of ["0", "91", "1.5"])
      await expect(run(["usage", "--days", days], {})).rejects.toThrow("--days");
    await expect(run(["billing", "transactions", "--limit", "201"], {})).rejects.toThrow("200");
    await expect(run(["billing", "transactions", "--bucket", "other"], {})).rejects.toThrow("--bucket");
  });
  it("shows the identity behind the saved credential", async () => {
    const result = await run(["whoami"], {
      account: { id: "acct_1", email: "dev@example.com", name: null },
      apiKey: { id: "key_1", name: "laptop", scopes: ["sandbox:read", "sandbox:execute"], createdAt: 1, lastUsedAt: null },
    });
    expect(result.code).toBe(0);
    expect(result.requests[0]?.url.pathname).toBe("/api/v2/me");
    expect(result.stdout).toBe(
      "dev@example.com\taccount=acct_1\nAPI key laptop\tkey_1\tscopes=sandbox:read,sandbox:execute\n",
    );
  });

  it("reports per-sandbox costs with an API key filter", async () => {
    const result = await run(["costs", "--from", "2026-10-01T00:00:00Z", "--api-key", "none"], {
      costs: {
        from: Date.parse("2026-10-01T00:00:00Z"),
        to: Date.parse("2026-10-07T00:00:00Z"),
        currency: "usd",
        estimates: "available",
        totals: { runs: 2, billableSeconds: 150, settledMicros: 3_000, estimatedMicros: 750 },
        apiKeys: [],
        sandboxes: [{ sandboxId: "sbx_1", name: "api", runs: 2, billableSeconds: 150, settledMicros: 3_000, estimatedMicros: 750, deleted: true }],
        unattributed: { runs: 0, billableSeconds: 0, settledMicros: 0, estimatedMicros: 0 },
      },
    });
    expect(result.code).toBe(0);
    expect(result.requests[0]?.url.pathname).toBe("/api/v2/costs/sandboxes");
    expect(Object.fromEntries(result.requests[0]!.url.searchParams)).toEqual({
      from: "2026-10-01T00:00:00.000Z",
      apiKeyId: "none",
    });
    expect(result.stdout).toBe("sbx_1\tapi\truns=2\tbillableSeconds=150\tsettled=$0.0030\testimated=$0.0008\tdeleted\n");
    expect(result.stderr).toContain("settled=$0.0030 estimated=$0.0008");
  });

  it("lists sandbox and deleted-sandbox runs", async () => {
    const live = await run(["sandbox", "costs", "sbx_1"], { costs: costDetail });
    expect(live.requests[0]?.url.pathname).toBe("/api/v2/sandboxes/sbx_1/costs");
    expect(live.stdout).toBe(
      "2026-10-03T04:00:00.000Z\t2026-10-03T04:02:00.000Z\tbillableSeconds=120\t$0.0030\n" +
      "2026-10-03T04:03:20.000Z\trunning\tbillableSeconds=30\t~$0.0008\n",
    );

    const deleted = await run(["--json", "deleted", "costs", "dsb_1"], { costs: costDetail });
    expect(deleted.requests[0]?.url.pathname).toBe("/api/v2/deleted-sandboxes/dsb_1/costs");
    expect(JSON.parse(deleted.stdout)).toEqual({ costs: costDetail });
  });

  it("pages the audit log and prints the next cursor", async () => {
    const result = await run(["audit", "--outcome", "error", "--method", "POST", "--limit", "20", "--before", "cur_1"], {
      events: [{
        id: "aud_1",
        type: "api.request",
        createdAt: Date.parse("2026-10-07T01:00:00Z"),
        requestId: "req_1",
        actor: { type: "api_key" },
        request: { method: "POST", route: "/api/v2/sandboxes", path: "/api/v2/sandboxes", status: 429, durationMs: 12 },
        resourceId: null,
      }],
      nextCursor: "cur_2",
    });
    expect(result.code).toBe(0);
    expect(Object.fromEntries(result.requests[0]!.url.searchParams)).toEqual({
      outcome: "error",
      method: "POST",
      before: "cur_1",
      limit: "20",
    });
    expect(result.stdout).toBe("2026-10-07T01:00:00.000Z\tapi.request\tPOST /api/v2/sandboxes\t429\t-\n");
    expect(result.stderr).toBe("More events: bxc audit --before cur_2\n");
  });

  it("lists deleted sandboxes by default and reads an earlier runtime's logs", async () => {
    const list = await run(["deleted"], {
      deletedSandboxes: [{ id: "dsb_1", sandboxId: "sbx_1", name: "api", deletedAt: Date.parse("2026-10-06T00:00:00Z") }],
    });
    expect(list.requests[0]?.url.pathname).toBe("/api/v2/deleted-sandboxes");
    expect(list.stdout).toBe("dsb_1\tsbx_1\tapi\tdeleted=2026-10-06T00:00:00.000Z\n");

    const logs = await run(["deleted", "logs", "dsb_1", "--runtime", "rt_1", "--stream", "stderr"], {
      logs: { sandboxId: "dsb_1", entries: [{ timestamp: "t", stream: "stderr", source: "process", message: "bye" }], truncated: false, retention_seconds: 60 },
    });
    expect(logs.requests[0]?.url.pathname).toBe("/api/v2/deleted-sandboxes/dsb_1/logs");
    expect(Object.fromEntries(logs.requests[0]!.url.searchParams)).toEqual({ stream: "stderr", runtime: "rt_1" });
    expect(logs.stdout).toBe("t\tstderr\tprocess\tbye\n");
  });

  it("summarizes analytics and validates the bucket width", async () => {
    const result = await run(["sandbox", "analytics", "sbx_1", "--resolution", "60", "--generation", "2"], {
      analytics: {
        sandboxId: "sbx_1",
        from: 0,
        to: 60_000,
        resolutionSeconds: 60,
        generations: [{ generation: 2, runtimeClass: "vm", startedAt: 0, stoppedAt: null }],
        operations: [
          { operations: 2, executions: 1, failures: 0 },
          { operations: 1, executions: 1, failures: 1 },
        ],
        resources: { status: "available" },
      },
    });
    expect(Object.fromEntries(result.requests[0]!.url.searchParams)).toEqual({ resolutionSeconds: "60", generation: "2" });
    expect(result.stdout).toBe(
      "generation=2\tvm\tstarted=1970-01-01T00:00:00.000Z\tstopped=-\noperations=3\texecutions=2\tfailures=1\n",
    );

    await expect(run(["sandbox", "analytics", "sbx_1", "--resolution", "30"], {}))
      .rejects.toThrow("--resolution must be from 60 to 86400 seconds");
  });

  it("opens and closes a browser preview", async () => {
    const preview = {
      previewId: "a".repeat(32),
      sandboxId: "sbx_1",
      port: 3000,
      url: "https://p.bxcpreview.com",
      expiresAt: "2026-10-07T13:00:00.000Z",
    };
    const opened = await run(["sandbox", "preview", "sbx_1", "--port", "3000"], { preview }, 201);
    expect(opened.requests[0]).toMatchObject({ method: "POST", body: "{\"port\":3000}" });
    expect(opened.requests[0]?.url.pathname).toBe("/api/v2/sandboxes/sbx_1/previews");
    expect(opened.stdout).toBe("https://p.bxcpreview.com\n");
    expect(opened.stderr).toContain(`--close ${preview.previewId}`);

    const closed = await run(["sandbox", "preview", "sbx_1", "--close", preview.previewId], undefined, 204);
    expect(closed.requests[0]?.method).toBe("DELETE");
    expect(closed.requests[0]?.url.pathname).toBe(`/api/v2/sandboxes/sbx_1/previews/${preview.previewId}`);

    await expect(run(["sandbox", "preview", "sbx_1"], {}))
      .rejects.toThrow("exactly one of --port PORT or --close PREVIEW_ID");
    await expect(run(["sandbox", "preview", "sbx_1", "--port", "70000"], {}))
      .rejects.toThrow("--port must be an integer from 1 to 65535");
  });

  it("prints help for the new command groups without authenticating", async () => {
    for (const [command, heading] of [
      ["deleted", "Usage: bxc deleted <command> [options]"],
      ["costs", "Usage: bxc costs [options]"],
      ["audit", "Usage: bxc audit [options]"],
    ] as const) {
      const io = streams();
      expect(await runCli([command, "--help"], { io, env: {} })).toBe(0);
      expect(output(io.stdout)).toContain(heading);
    }
  });
});
