import { describe, expect, it } from "bun:test";
import { BoxCompute } from "@boxcompute/sdk";
import { buildCreateSandboxRequest, createClient } from "../src/sdk.js";

const connection = { url: "https://app.boxcompute.ai", token: "bc_live_test", tokenFile: "/credential" };

describe("buildCreateSandboxRequest", () => {
  it("builds the default VM request with explicit small sizing", () => {
    expect(buildCreateSandboxRequest("ws_one", { size: "small" }))
      .toEqual({ workspaceId: "ws_one", size: "small" });
  });

  it("omits runtime and size when the caller relies on the server default", () => {
    expect(buildCreateSandboxRequest("ws_one")).toEqual({ workspaceId: "ws_one" });
  });

  it("sends VM size", () => {
    expect(buildCreateSandboxRequest("ws_one", { vmSandbox: true, size: "small", idempotencyKey: "key-one" }))
      .toEqual({ workspaceId: "ws_one", vmSandbox: true, size: "small", idempotencyKey: "key-one" });
    expect(buildCreateSandboxRequest("ws_one", { vmSandbox: true, size: "large", idempotencyKey: "key-two" }))
      .toEqual({ workspaceId: "ws_one", vmSandbox: true, size: "large", idempotencyKey: "key-two" });
  });

  it("rejects invalid keys, names and conflicting runtime options before any request", () => {
    for (const key of [undefined, "", "bad key", "a".repeat(256), "bad\nkey"]) {
      expect(() => buildCreateSandboxRequest("ws_one", { vmSandbox: true, idempotencyKey: key })).toThrow();
    }
    expect(() => buildCreateSandboxRequest("ws_one", { name: " " })).toThrow();
    expect(() => buildCreateSandboxRequest("ws_one", { vmSandbox: true })).toThrow();
  });
});

describe("createClient", () => {
  it("uses the saved connection and forces redirect rejection", async () => {
    let seen: RequestInit | undefined;
    let authorization = "";
    const client = createClient(connection, (async (_input: string | URL | Request, init?: RequestInit) => {
      seen = init;
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ workspaces: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    expect(client).toBeInstanceOf(BoxCompute);
    await client.workspaces.list();
    expect(authorization).toBe("Bearer bc_live_test");
    expect(seen?.redirect).toBe("error");
  });
});
