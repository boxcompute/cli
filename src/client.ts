import type { Connection } from "./config.js";

export type Sandbox = {
  id: string;
  workspaceId: string;
  name: string;
  state: "cold" | "running";
  runtimeId: string | null;
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

  async delete(id: string): Promise<void> {
    await this.request(`/api/v2/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
