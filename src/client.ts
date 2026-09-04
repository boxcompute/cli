import type { Connection } from "./config.js";

export type Sandbox = {
  id: string;
  workspaceId: string;
  name: string;
  state: "not-created" | "cold" | "running";
  runtimeId: string | null;
  image: string | null;
  createdAt: number;
  lastUsedAt: number | null;
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

  private request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.connection.token}`);
    return publicRequest<T>(this.connection.url, pathname, { ...init, headers }, this.fetchImpl);
  }

  async list(): Promise<Sandbox[]> {
    return (await this.request<{ sandboxes: Sandbox[] }>("/api/v1/sandboxes")).sandboxes;
  }

  async logout(): Promise<void> {
    await this.request("/api/v1/auth", { method: "DELETE" });
  }

  async inspect(id: string): Promise<Sandbox> {
    return (await this.request<{ sandbox: Sandbox }>(`/api/v1/sandboxes/${encodeURIComponent(id)}`)).sandbox;
  }

  async start(workspaceId: string): Promise<Sandbox> {
    return (await this.request<{ sandbox: Sandbox }>("/api/v1/sandboxes", {
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
    return (await this.request<{ result: Execution }>(`/api/v1/sandboxes/${encodeURIComponent(id)}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })).result;
  }

  async delete(id: string): Promise<void> {
    await this.request(`/api/v1/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
