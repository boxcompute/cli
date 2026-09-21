import { describe, expect, it } from "bun:test";
import { cooperativeConnectionApi } from "../src/cooperative-connection.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

const connection = { url: "https://app.boxcompute.ai", token: "bc_live_secret", tokenFile: "/credential" };
const keys = {
  client_key: `nodekey:${"a".repeat(64)}`,
  ssh_key: `ssh-ed25519 ${"A".repeat(68)}`,
  recipient_key: Buffer.alloc(32, 2).toString("base64"),
};

describe("cooperative connection client", () => {
  it("uses the bounded public cooperative routes without retrying mutations", async () => {
    const endpointId = "12345678-1234-4234-8234-123456789abc";
    const envelope = {
      endpoint_id: endpointId,
      expires_at: Math.floor(Date.now() / 1000) + 25,
      sealed: Buffer.alloc(96, 3).toString("base64"),
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = cooperativeConnectionApi(connection, (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return json(init?.method === "DELETE"
        ? { endpoint_id: endpointId, cleanup: "unconfirmed" }
        : envelope, init?.method === "DELETE" ? 202 : init?.method === "POST" ? 201 : 200);
    }) as typeof fetch);

    expect(await api.activateCooperativeConnection("sbx_demo", keys)).toEqual(envelope);
    expect(await api.reconnectCooperativeConnection("sbx_demo", endpointId, keys)).toEqual(envelope);
    await api.revokeCooperativeConnection("sbx_demo", endpointId);

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
    const api = cooperativeConnectionApi(connection, (async () =>
      json({ private: "unexpected" }, 503)) as unknown as typeof fetch);
    await expect(api.activateCooperativeConnection("runtime-internal", keys)).rejects.toThrow("unavailable");
    await expect(api.activateCooperativeConnection("sbx_demo", keys)).rejects.toThrow("unavailable");
  });
});
