import type { Connection } from "./config.js";

export const FILE_CHUNK_BYTES = 8_388_608;

export type FileChunk = {
  bytes: Uint8Array;
  nextOffset: number;
  size: number;
  eof: boolean;
  nextCursor?: string;
};

export function validateFilePath(path: string): void {
  if (path.length > 4096 || path.includes("\0") ||
    !(path === "/workspace" || path.startsWith("/workspace/")) ||
    path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Remote file paths must be absolute under /workspace, at most 4096 characters, without dot components or NUL");
  }
}

export type Sandbox = {
  id: string;
  workspaceId: string;
  name: string;
  state: "cold" | "pending" | "running" | "expired";
  vmSandbox?: boolean;
  runtimeId?: string | null;
  retainedRuntimeId?: string | null;
  image?: string | null;
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

  async start(workspaceId: string, input: {
    vmSandbox?: boolean;
    idempotencyKey?: string;
    name?: string;
  } = {}): Promise<Sandbox> {
    if (input.vmSandbox && !input.idempotencyKey) throw new Error("VM creation requires --idempotency-key; reuse the same key and options on retry");
    if (input.idempotencyKey !== undefined && !/^[\x21-\x7e]{1,255}$/.test(input.idempotencyKey)) {
      throw new Error("Idempotency key must contain 1–255 visible ASCII characters without spaces");
    }
    const name = input.name?.trim();
    if (name !== undefined && (!name || name.length > 80)) throw new Error("Sandbox name must contain 1–80 trimmed characters");
    const sandbox = (await this.request<{ sandbox: Sandbox }>("/api/v2/sandboxes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.idempotencyKey !== undefined ? { "idempotency-key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify({ workspaceId, ...(input.vmSandbox ? { vmSandbox: true } : {}), ...(name !== undefined ? { name } : {}) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    })).sandbox;
    if (input.vmSandbox && sandbox.vmSandbox !== true) {
      throw new Error(`Server did not confirm VM selection for sandbox ${sandbox.id}; inspect and clean up that ID before retrying. Upgrade the server to one that supports VM creation.`);
    }
    return sandbox;
  }

  async upload(id: string, path: string, bytes: Uint8Array): Promise<void> {
    validateFilePath(path);
    if (bytes.byteLength > FILE_CHUNK_BYTES) throw new Error("Uploads are limited to 8 MiB");
    const response = await this.fetchImpl(new URL(
      `/api/v2/sandboxes/${encodeURIComponent(id)}/files/content?${new URLSearchParams({ path })}`,
      this.connection.url,
    ), {
      method: "PUT",
      headers: { authorization: `Bearer ${this.connection.token}`, "content-type": "application/octet-stream" },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw await responseError(response);
    await response.body?.cancel();
    if (response.status !== 204) throw new Error("File upload returned an unexpected status");
  }

  async readFile(id: string, path: string, offset = 0, cursor?: string, signal?: AbortSignal): Promise<FileChunk> {
    validateFilePath(path);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid file offset");
    const query = new URLSearchParams({ path, offset: String(offset), maxBytes: String(FILE_CHUNK_BYTES) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const response = await this.fetchImpl(new URL(
      `/api/v2/sandboxes/${encodeURIComponent(id)}/files/content?${query}`, this.connection.url,
    ), {
      headers: { authorization: `Bearer ${this.connection.token}` },
      signal: signal ?? AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw await responseError(response);
    try {
      if (response.status !== 200) throw new Error("File reads require HTTP 200");
      const integer = (name: string) => {
        const value = response.headers.get(`x-boxcompute-${name}`);
        if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid file range metadata");
        return Number(value);
      };
      const start = integer("offset");
      const nextOffset = integer("next-offset");
      const size = integer("file-size");
      const eof = response.headers.get("x-boxcompute-eof");
      const nextCursor = response.headers.get("x-boxcompute-next-cursor");
      if (start !== offset || nextOffset < start || nextOffset > size || nextOffset - start > FILE_CHUNK_BYTES ||
        (eof !== "true" && eof !== "false") || (eof === "true") !== (nextOffset === size) ||
        (eof === "false" && (nextOffset === start || !nextCursor))) throw new Error("Invalid file range metadata");
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > nextOffset - start) throw new Error("File response exceeds its declared range");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      if (length !== nextOffset - start) throw new Error("Incomplete file response");
      return { bytes: Buffer.concat(chunks), nextOffset, size, eof: eof === "true", nextCursor: nextCursor ?? undefined };
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
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
