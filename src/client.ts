import type { Connection } from "./config.js";

export type Sandbox = {
  id: string;
  workspaceId: string;
  name: string;
  state: "cold" | "running";
  runtimeId: string | null;
  retainedRuntimeId: string | null;
  image: string | null;
  createdAt: number;
  lastUsedAt: number | null;
};

export type Workspace = {
  id: string;
  name: string;
  createdAt: number;
};

export type Execution = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  wallTimeSeconds: number;
};

export type SandboxLogEntry = {
  timestamp: string;
  stream: "stdout" | "stderr";
  source: "workload" | "execute" | "process";
  message: string;
  pod_uid: string;
  process_id?: string;
};

export type SandboxLogs = {
  sandbox_id: string;
  entries: SandboxLogEntry[];
  truncated: boolean;
  retention_seconds: number;
};

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

const sandboxSlotPattern = /^sbx_[a-zA-Z0-9_-]+$/;
const endpointPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const cooperativeUnavailable = () => new Error("Cooperative SSH is unavailable; an unacknowledged enrollment may remain until its lease expires.");

export class BoxComputeHttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = "BoxComputeHttpError";
  }
}

async function responseError(response: Response): Promise<BoxComputeHttpError> {
  const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
  return new BoxComputeHttpError(response.status, body.error ?? `BoxCompute returned HTTP ${response.status}`, body.code);
}

export async function publicRequest<T>(
  url: string,
  pathname: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(new URL(pathname, `${url}/`), init);
  if (!response.ok) throw await responseError(response);
  return response.status === 204 ? undefined as T : await response.json() as T;
}

export class BoxComputeClient {
  constructor(private readonly connection: Connection, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.connection.token}`);
    try {
      return await publicRequest<T>(
        this.connection.url,
        pathname,
        { ...init, headers },
        this.fetchImpl,
      );
    } catch (error) {
      const isV2Discovery = pathname === "/api/v2/sandboxes" ||
        pathname === "/api/v2/workspaces" || pathname === "/api/v2/auth";
      if (isV2Discovery && error instanceof BoxComputeHttpError && error.status === 404) {
        throw new BoxComputeHttpError(
          404,
          "This BoxCompute server does not support Sandbox API v2 yet. Upgrade the server before this CLI.",
          error.code,
        );
      }
      throw error;
    }
  }

  async list(): Promise<Sandbox[]> {
    return (await this.request<{ sandboxes: Sandbox[] }>("/api/v2/sandboxes")).sandboxes;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return (await this.request<{ workspaces: Workspace[] }>("/api/v2/workspaces")).workspaces;
  }

  async logout(): Promise<void> {
    await this.request("/api/v2/auth", { method: "DELETE" });
  }

  async inspect(id: string): Promise<Sandbox> {
    return (await this.request<{ sandbox: Sandbox }>(`/api/v2/sandboxes/${encodeURIComponent(id)}`)).sandbox;
  }

  async start(workspaceId: string): Promise<Sandbox> {
    return (await this.request<{ sandbox: Sandbox }>("/api/v2/sandboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    })).sandbox;
  }

  async execute(id: string, input: {
    argv: string[];
    cwd?: string;
    timeoutSeconds?: number;
    maxOutputBytes?: number;
    env?: Record<string, string>;
  }): Promise<Execution> {
    return (await this.request<{ result: Execution }>(`/api/v2/sandboxes/${encodeURIComponent(id)}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })).result;
  }

  private async cooperativeRequest(
    id: string,
    action: "activate" | "reconnect" | "revoke",
    keys?: CooperativeConnectionKeys,
    endpointId?: string,
  ): Promise<unknown> {
    try {
      const origin = new URL(this.connection.url);
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
      const headers = new Headers({ authorization: `Bearer ${this.connection.token}` });
      if (keys) headers.set("content-type", "application/json");
      const response = await this.fetchImpl(new URL(pathname, `${origin.origin}/`), {
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

  private cooperativeEnvelope(value: unknown, endpointId?: string): CooperativeConnectionEnvelope {
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

  async activateCooperativeConnection(id: string, keys: CooperativeConnectionKeys): Promise<CooperativeConnectionEnvelope> {
    return this.cooperativeEnvelope(await this.cooperativeRequest(id, "activate", keys));
  }

  async reconnectCooperativeConnection(
    id: string,
    endpointId: string,
    keys: CooperativeConnectionKeys,
  ): Promise<CooperativeConnectionEnvelope> {
    return this.cooperativeEnvelope(
      await this.cooperativeRequest(id, "reconnect", keys, endpointId),
      endpointId,
    );
  }

  async revokeCooperativeConnection(id: string, endpointId: string): Promise<void> {
    const response = await this.cooperativeRequest(id, "revoke", undefined, endpointId) as {
      endpoint_id?: unknown;
      cleanup?: unknown;
    };
    if (
      !response ||
      Object.keys(response).sort().join() !== "cleanup,endpoint_id" ||
      response.endpoint_id !== endpointId ||
      response.cleanup !== "unconfirmed"
    ) throw cooperativeUnavailable();
  }

  async logs(id: string, input: {
    since?: string;
    until?: string;
    stream?: "stdout" | "stderr";
    source?: "workload" | "execute" | "process";
    limit?: number;
  } = {}): Promise<SandboxLogs> {
    const query = new URLSearchParams();
    if (input.since) query.set("since", input.since);
    if (input.until) query.set("until", input.until);
    if (input.stream) query.set("stream", input.stream);
    if (input.source) query.set("source", input.source);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query}` : "";
    return (await this.request<{ logs: SandboxLogs }>(
      `/api/v2/sandboxes/${encodeURIComponent(id)}/logs${suffix}`,
    )).logs;
  }

  async delete(id: string): Promise<void> {
    await this.request(`/api/v2/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
