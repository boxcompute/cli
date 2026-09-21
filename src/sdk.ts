import {
  BoxCompute,
  type CreateSandboxRequest,
} from "@boxcompute/sdk";
import type { Connection } from "./config.js";

export const FILE_CHUNK_BYTES = 8_388_608;

/** VM compute size tier: `small` (0.5 vCPU / 1024 MiB) or `large` (1.5 vCPU / 3072 MiB). */
export type SandboxSize = "small" | "large";

export function validateFilePath(path: string): void {
  if (path.length > 4096 || path.includes("\0") ||
    !(path === "/workspace" || path.startsWith("/workspace/")) ||
    path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Remote file paths must be absolute under /workspace, at most 4096 characters, without dot components or NUL");
  }
}

export type SandboxStartInput = {
  cpu?: number;
  vmSandbox?: boolean;
  gvisor?: boolean;
  size?: SandboxSize;
  idempotencyKey?: string;
  name?: string;
};

/**
 * Validate the create options and build the SDK create request. The runtime
 * selection rules live here so the CLI never reimplements the v2 contract:
 * - `gvisor` selects `vmSandbox: false` (the CLI derives this from `--gvisor`
 *   or the gVisor-only `--cpu` flag);
 * - an explicit `vmSandbox` selects `vmSandbox: true` and requires a key;
 * - otherwise `vmSandbox` is omitted and the server default (VM) applies.
 * `cpu` is a gVisor-only scheduler request carried on the create body; the
 * public v2 contract keeps `additionalProperties` open for it.
 */
export function buildCreateSandboxRequest(
  workspaceId: string,
  input: SandboxStartInput = {},
): CreateSandboxRequest & { idempotencyKey?: string } {
  if (input.vmSandbox && input.gvisor) throw new Error("VM and gVisor selection are mutually exclusive");
  if (input.vmSandbox && input.cpu !== undefined) throw new Error("VM sandboxes use a fixed CPU profile; --cpu selects the gVisor runtime");
  if (input.vmSandbox && !input.idempotencyKey) throw new Error("VM creation requires --idempotency-key; reuse the same key and options on retry");
  if (input.gvisor && input.size === "large") throw new Error("--size large is VM only; gVisor container sandboxes ignore --size small");
  if (input.idempotencyKey !== undefined && !/^[\x21-\x7e]{1,255}$/.test(input.idempotencyKey)) {
    throw new Error("Idempotency key must contain 1–255 visible ASCII characters without spaces");
  }
  const name = input.name?.trim();
  if (name !== undefined && (!name || name.length > 80)) throw new Error("Sandbox name must contain 1–80 trimmed characters");

  const body: CreateSandboxRequest & { cpu?: number } = { workspaceId };
  if (input.cpu !== undefined) body.cpu = input.cpu;
  if (input.gvisor) body.vmSandbox = false;
  else if (input.vmSandbox) body.vmSandbox = true;
  // VM sizing only: gVisor uses the default profile and must not receive size.
  if (!input.gvisor && input.size !== undefined) body.size = input.size;
  if (name !== undefined) body.name = name;

  return { ...body, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) };
}

/**
 * Build a BoxCompute SDK client for the saved connection. The CLI keeps the
 * bearer token in the SDK transport only and forces `redirect: "error"` on
 * every request so the credential is never forwarded to a different origin.
 */
export function createClient(connection: Connection, fetchImpl: typeof fetch): BoxCompute {
  const rejectRedirects = ((input: string | URL | Request, init?: RequestInit) =>
    fetchImpl(input, { ...init, redirect: "error" })) as typeof fetch;
  return new BoxCompute({
    apiKey: connection.token,
    baseUrl: connection.url,
    fetch: rejectRedirects,
  });
}
