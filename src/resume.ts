import type { Sandbox, operations } from "@boxcompute/sdk";
import type { Connection } from "./config.js";

/** The SDK declares startExistingSandbox but does not yet expose a resource method. */
export async function resumeSandbox(connection: Connection, fetchImpl: typeof fetch, id: string, key?: string): Promise<Sandbox> {
  if (!/^sbx_[a-zA-Z0-9_-]+$/.test(id)) throw new Error("A sandbox ID is required");
  if (key !== undefined && !/^[\x21-\x7e]{1,255}$/.test(key)) throw new Error("Invalid idempotency key");
  const origin = new URL(connection.url);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
      || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("Resume requires HTTPS or a loopback development server");
  }
  try {
    const response = await fetchImpl(new URL(`/api/v2/sandboxes/${encodeURIComponent(id)}/start`, origin), {
      method: "POST", body: "{}", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}) },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("resume_failed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 65_536) throw new Error("response_limit");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as
      operations["startExistingSandbox"]["responses"][201]["content"]["application/json"];
    if (value?.sandbox?.id !== id || !["running", "pending", "cold", "expired"].includes(value.sandbox.state)) {
      throw new Error("unexpected_sandbox");
    }
    return value.sandbox;
  } catch {
    throw new Error("Resume was not confirmed. Inspect this sandbox's status before retrying; no automatic retry was attempted.");
  }
}
