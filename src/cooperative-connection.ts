import type { Connection } from "./config.js";

export type CooperativeConnectionKeys = {
  client_key: string;
  ssh_key: string;
  recipient_key: string;
};

export type CooperativeConnectionEnvelope = {
  endpoint_id: string;
  expires_at: number;
  sealed: string;
};

export interface CooperativeConnectionApi {
  activateCooperativeConnection(id: string, keys: CooperativeConnectionKeys): Promise<CooperativeConnectionEnvelope>;
  reconnectCooperativeConnection(
    id: string,
    endpointId: string,
    keys: CooperativeConnectionKeys,
  ): Promise<CooperativeConnectionEnvelope>;
  revokeCooperativeConnection(id: string, endpointId: string): Promise<void>;
}

const sandboxSlotPattern = /^sbx_[a-zA-Z0-9_-]+$/;
const endpointPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cooperativeUnavailable = () => new Error(
  "Cooperative SSH is unavailable; an unacknowledged enrollment may remain until its lease expires.",
);

/**
 * Build a client for the experimental cooperative-SSH enrollment endpoints
 * (`/api/v2/sandboxes/{id}/cooperative-connection`). These routes are not part
 * of `@boxcompute/sdk`, so the CLI keeps a small, validation-complete transport
 * for them while the rest of the API goes through the SDK.
 */
export function cooperativeConnectionApi(
  connection: Connection,
  fetchImpl: typeof fetch,
): CooperativeConnectionApi {
  async function cooperativeRequest(
    id: string,
    action: "activate" | "reconnect" | "revoke",
    keys?: CooperativeConnectionKeys,
    endpointId?: string,
  ): Promise<unknown> {
    try {
      const origin = new URL(connection.url);
      if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        (origin.pathname !== "/" && origin.pathname !== "") ||
        origin.search ||
        origin.hash
      ) throw cooperativeUnavailable();
      if (!sandboxSlotPattern.test(id)) throw cooperativeUnavailable();
      if (action !== "activate" && !endpointPattern.test(endpointId ?? "")) throw cooperativeUnavailable();
      if (action !== "revoke" && (
        !keys ||
        Object.keys(keys).sort().join() !== "client_key,recipient_key,ssh_key" ||
        !/^nodekey:(?!0{64}$)[a-f0-9]{64}$/.test(keys.client_key) ||
        !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(keys.ssh_key) ||
        !/^[A-Za-z0-9+/]{43}=$/.test(keys.recipient_key)
      )) throw cooperativeUnavailable();

      const base = `/api/v2/sandboxes/${encodeURIComponent(id)}/cooperative-connection`;
      const pathname = action === "activate" ? base : `${base}/${encodeURIComponent(endpointId!)}`;
      const signal = AbortSignal.timeout(10_000);
      const headers = new Headers({ authorization: `Bearer ${connection.token}` });
      if (keys) headers.set("content-type", "application/json");
      const response = await fetchImpl(new URL(pathname, `${origin.origin}/`), {
        method: action === "revoke" ? "DELETE" : "POST",
        headers,
        redirect: "error",
        signal,
        ...(keys ? { body: JSON.stringify(keys) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw cooperativeUnavailable();
      }
      const reader = response.body?.getReader();
      if (!reader) throw cooperativeUnavailable();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16_384) throw cooperativeUnavailable();
          chunks.push(value);
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } catch {
      throw cooperativeUnavailable();
    }
  }

  function cooperativeEnvelope(value: unknown, endpointId?: string): CooperativeConnectionEnvelope {
    const envelope = value as CooperativeConnectionEnvelope;
    const now = Math.floor(Date.now() / 1000);
    if (
      !envelope ||
      Object.keys(envelope).sort().join() !== "endpoint_id,expires_at,sealed" ||
      !endpointPattern.test(envelope.endpoint_id) ||
      (endpointId !== undefined && envelope.endpoint_id !== endpointId) ||
      !Number.isSafeInteger(envelope.expires_at) ||
      envelope.expires_at <= now ||
      envelope.expires_at > now + 30 ||
      typeof envelope.sealed !== "string" ||
      envelope.sealed.length < 80 ||
      envelope.sealed.length > 16_000 ||
      Buffer.from(envelope.sealed, "base64").toString("base64") !== envelope.sealed
    ) throw cooperativeUnavailable();
    return envelope;
  }

  return {
    activateCooperativeConnection: async (id, keys) =>
      cooperativeEnvelope(await cooperativeRequest(id, "activate", keys)),
    reconnectCooperativeConnection: async (id, endpointId, keys) =>
      cooperativeEnvelope(await cooperativeRequest(id, "reconnect", keys, endpointId), endpointId),
    revokeCooperativeConnection: async (id, endpointId) => {
      const response = await cooperativeRequest(id, "revoke", undefined, endpointId) as {
        endpoint_id?: unknown;
        cleanup?: unknown;
      };
      if (
        !response ||
        Object.keys(response).sort().join() !== "cleanup,endpoint_id" ||
        response.endpoint_id !== endpointId ||
        response.cleanup !== "unconfirmed"
      ) throw cooperativeUnavailable();
    },
  };
}
