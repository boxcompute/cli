import { describe, expect, it } from "bun:test";
import { serviceAccessApi } from "../src/service-access.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

describe("service access client", () => {
  it("creates and revokes service access without retrying or leaking operation ids into the body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const generation = "87654321-1234-4123-8123-123456789abc";
    const request = {
      operation_id: "12345678-1234-4123-8123-123456789abc",
      requested_at: Math.floor(Date.now() / 1000) - 1,
      client_key: `nodekey:${"a".repeat(64)}`,
      recipient_key: Buffer.alloc(32, 2).toString("base64"),
      ports: [3000],
    };
    const envelope = {
      generation_id: generation,
      expires_at: request.requested_at + 300,
      sealed: Buffer.alloc(96, 4).toString("base64"),
    };
    const api = serviceAccessApi(
      { url: "https://app.boxcompute.ai", token: "bc_live_secret", tokenFile: "/credential" },
      (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return json(init?.method === "DELETE"
          ? { generation_id: generation, cleanup: "untrusted-guest-report" }
          : envelope, init?.method === "DELETE" ? 200 : 201);
      }) as typeof fetch,
    );

    expect(await api.createServiceAccess("sbx_one", request)).toEqual(envelope);
    expect(await api.revokeServiceAccess("sbx_one", generation)).toBe("untrusted-guest-report");
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
});
