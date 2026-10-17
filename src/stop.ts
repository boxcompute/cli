import { BoxComputeError, type Sandbox } from "@boxcompute/sdk";
import type { Connection } from "./config.js";

export type StopResult = { sandbox: Sandbox; stopped: boolean };

/**
 * `POST /api/v2/sandboxes/{id}/stop` (server 0.62.0+). The SDK does not expose
 * it yet, so this keeps resume's origin, ID, redirect and size checks. Stopping
 * is idempotent and never wakes compute, so unlike resume, server errors are
 * shown as they are: a retry cannot start or double-bill anything.
 */
export async function stopSandbox(connection: Connection, fetchImpl: typeof fetch, id: string): Promise<StopResult> {
  if (!/^sbx_[a-zA-Z0-9_-]+$/.test(id)) throw new Error("A sandbox ID is required");
  const origin = new URL(connection.url);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
      || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("Stop requires HTTPS or a loopback development server");
  }
  let response: Response;
  try {
    response = await fetchImpl(new URL(`/api/v2/sandboxes/${encodeURIComponent(id)}/stop`, origin), {
      method: "POST", body: "{}", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json", accept: "application/json" },
    });
  } catch {
    throw new Error(`Stop request did not reach BoxCompute. Check 'bxc sandbox status ${id}', then retry.`);
  }
  const value = await boundedJson(response);
  if (!response.ok) {
    const body = value as { code?: unknown; error?: unknown } | undefined;
    const code = typeof body?.code === "string" ? body.code : undefined;
    const message = typeof body?.error === "string" ? body.error : undefined;
    // A server older than 0.62.0 has no such route and answers without the API's error body.
    if ((response.status === 404 || response.status === 405) && !code) {
      throw new Error(`This BoxCompute server does not support stopping a sandbox yet (HTTP ${response.status}).`);
    }
    if (response.status === 409) {
      throw new BoxComputeError({ status: 409, code: code ?? "SANDBOX_UNAVAILABLE",
        message: `Sandbox ${id} is still starting, stopping or in use; run 'bxc sandbox stop ${id}' again in a moment` });
    }
    throw new BoxComputeError({ status: response.status, code: code ?? "HTTP_ERROR",
      message: message ?? `BoxCompute returned HTTP ${response.status}` });
  }
  const result = value as Partial<StopResult> | undefined;
  if (result?.sandbox?.id !== id || typeof result.stopped !== "boolean"
      || !["running", "pending", "cold", "expired"].includes(result.sandbox.state)) {
    throw new Error(`Stop was not confirmed. Check 'bxc sandbox status ${id}' before retrying.`);
  }
  return { sandbox: result.sandbox, stopped: result.stopped };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65_536) return undefined;
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return undefined;
  }
}
