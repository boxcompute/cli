import type { Connection } from "./config.js";

export type ServiceAccessRequest = {
  operation_id: string;
  requested_at: number;
  client_key: string;
  recipient_key: string;
  ports: number[];
};

export type ServiceAccessResponse = {
  generation_id: string;
  expires_at: number;
  sealed: string;
};

export type ServiceCleanup = "guardian-confirmed" | "untrusted-guest-report";

export interface ServiceAccessApi {
  createServiceAccess(id: string, request: ServiceAccessRequest): Promise<ServiceAccessResponse>;
  lookupServiceAccess(id: string, request: ServiceAccessRequest): Promise<ServiceAccessResponse>;
  revokeServiceAccess(id: string, generation: string): Promise<ServiceCleanup>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Build a client for the owned-VM service-access endpoints
 * (`/api/v2/sandboxes/{id}/services`). These routes are not part of
 * `@boxcompute/sdk`, so the CLI keeps a small, validation-complete transport
 * for them while the rest of the API goes through the SDK.
 */
export function serviceAccessApi(connection: Connection, fetchImpl: typeof fetch): ServiceAccessApi {
  const unavailable = () => new Error(
    "Service access unavailable; no mutation retry was attempted. Any unconfirmed access expires at its original deadline.",
  );

  async function serviceAccess(
    id: string,
    action: "create" | "lookup" | "revoke",
    request?: ServiceAccessRequest,
    generation?: string,
  ): Promise<ServiceAccessResponse | { generation_id: string; cleanup: ServiceCleanup }> {
    try {
      if (!/^sbx_[a-zA-Z0-9_-]+$/.test(id)) throw unavailable();
      if (action === "revoke") {
        if (!uuid.test(generation ?? "")) throw unavailable();
      } else {
        const now = Math.floor(Date.now() / 1000);
        if (!request || Object.keys(request).sort().join() !== "client_key,operation_id,ports,recipient_key,requested_at"
          || !uuid.test(request.operation_id) || !Number.isSafeInteger(request.requested_at)
          || request.requested_at <= 0 || request.requested_at > now || now - request.requested_at >= 300
          || !/^nodekey:(?!0{64}$)[a-f0-9]{64}$/.test(request.client_key)
          || Buffer.from(request.recipient_key, "base64").length !== 32
          || Buffer.from(request.recipient_key, "base64").toString("base64") !== request.recipient_key
          || request.ports.length < 1 || request.ports.length > 8
          || request.ports.some((port, index) => !Number.isInteger(port) || port < 1 || port > 65_535
            || (index > 0 && port <= request.ports[index - 1]!))) throw unavailable();
      }
      const base = `/api/v2/sandboxes/${encodeURIComponent(id)}/services`;
      const { operation_id, ...body } = request ?? {};
      const response = await fetchImpl(new URL(
        action === "create" ? base : action === "lookup" ? `${base}/lookup` : `${base}/${encodeURIComponent(generation!)}`,
        `${connection.url}/`,
      ), {
        method: action === "revoke" ? "DELETE" : "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          ...(request ? { "content-type": "application/json", "idempotency-key": operation_id! } : {}),
        },
        ...(request ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(action === "create" ? 45_000 : 25_000),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw unavailable();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 16_384) throw unavailable();
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ) as Record<string, unknown>;
      if (action === "revoke") {
        if (Object.keys(value).sort().join() !== "cleanup,generation_id" || value.generation_id !== generation
          || (value.cleanup !== "guardian-confirmed" && value.cleanup !== "untrusted-guest-report")) throw unavailable();
        return value as { generation_id: string; cleanup: ServiceCleanup };
      }
      if (Object.keys(value).sort().join() !== "expires_at,generation_id,sealed"
        || typeof value.generation_id !== "string" || !uuid.test(value.generation_id)
        || value.expires_at !== request!.requested_at + 300 || Number(value.expires_at) <= Math.floor(Date.now() / 1000)
        || typeof value.sealed !== "string" || value.sealed.length < 80 || value.sealed.length > 16_000
        || Buffer.from(value.sealed, "base64").toString("base64") !== value.sealed) throw unavailable();
      return value as ServiceAccessResponse;
    } catch {
      throw unavailable();
    }
  }

  return {
    createServiceAccess: (id, request) => serviceAccess(id, "create", request) as Promise<ServiceAccessResponse>,
    lookupServiceAccess: (id, request) => serviceAccess(id, "lookup", request) as Promise<ServiceAccessResponse>,
    revokeServiceAccess: async (id, generation) =>
      ((await serviceAccess(id, "revoke", undefined, generation)) as { cleanup: ServiceCleanup }).cleanup,
  };
}
