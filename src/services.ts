import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ServiceAccessApi, ServiceAccessRequest, ServiceAccessResponse, ServiceCleanup } from "./service-access.js";

export type ServiceMapping = { local: number; remote: number };

const unavailable = () => new Error(
  "Service access unavailable; no mutation retry was attempted. Any unconfirmed access expires at its original deadline.",
);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function nativeMessage(
  child: ChildProcessByStdio<Writable, Readable, null>,
  message: object,
  stop: () => void,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.off("close", failed);
      child.stdout.off("data", data);
    };
    const failed = () => { cleanup(); reject(unavailable()); };
    const timer = setTimeout(() => { stop(); failed(); }, 10_000);
    const data = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (Buffer.byteLength(buffered) > 4_096) { stop(); failed(); return; }
      if (!buffered.includes("\n")) return;
      cleanup();
      try {
        const value: unknown = JSON.parse(buffered);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
        resolve(value as Record<string, unknown>);
      } catch { stop(); reject(unavailable()); }
    };
    child.once("close", failed);
    child.stdout.on("data", data);
    child.stdin.write(JSON.stringify(message) + "\n");
  });
}

export function unsealServices(value: ServiceAccessResponse, recipient: KeyObject, request: ServiceAccessRequest) {
  try {
    const now = Date.now() / 1_000;
    if (!value || Object.keys(value).sort().join() !== "expires_at,generation_id,sealed"
      || !uuid.test(value.generation_id) || value.expires_at !== request.requested_at + 300
      || value.expires_at <= now || value.expires_at > now + 330
      || typeof value.sealed !== "string" || value.sealed.length < 80 || value.sealed.length > 16_000) throw unavailable();
    const bytes = Buffer.from(value.sealed, "base64");
    if (bytes.toString("base64") !== value.sealed) throw unavailable();
    const shared = diffieHellman({
      privateKey: recipient,
      publicKey: createPublicKey({
        format: "der",
        type: "spki",
        key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), bytes.subarray(0, 32)]),
      }),
    });
    const secret = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "boxcompute-connection-v1", 32));
    let clear: Buffer;
    try {
      const cipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(32, 44));
      cipher.setAAD(Buffer.from(value.generation_id));
      cipher.setAuthTag(bytes.subarray(-16));
      clear = Buffer.concat([cipher.update(bytes.subarray(44, -16)), cipher.final()]);
    } finally {
      shared.fill(0);
      secret.fill(0);
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(clear);
      const inner = JSON.parse(text) as { address: unknown; expires_at: unknown; ports: unknown };
      if (text !== JSON.stringify({ address: inner.address, expires_at: inner.expires_at, ports: inner.ports })
        || inner.expires_at !== value.expires_at || JSON.stringify(inner.ports) !== JSON.stringify(request.ports)
        || typeof inner.address !== "string" || inner.address.length > 4_096
        || !/^[A-Za-z0-9_+/:=.-]+$/.test(inner.address)) throw unavailable();
      return { address: inner.address, expires_at: value.expires_at };
    } finally { clear.fill(0); }
  } catch { throw unavailable(); }
}

/** Bind every local IPv4-loopback port before issuing one non-renewable grant. */
export async function openServices(
  api: ServiceAccessApi,
  sandboxId: string,
  mappings: readonly ServiceMapping[],
  signal?: AbortSignal,
) {
  if (signal?.aborted || !["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)
    || mappings.length < 1 || mappings.length > 8
    || mappings.some((mapping) => Object.keys(mapping).sort().join() !== "local,remote"
      || !Number.isInteger(mapping.local) || mapping.local < 1 || mapping.local > 65_535
      || !Number.isInteger(mapping.remote) || mapping.remote < 1 || mapping.remote > 65_535)
    || new Set(mappings.map(mapping => mapping.local)).size !== mappings.length
    || new Set(mappings.map(mapping => mapping.remote)).size !== mappings.length) throw unavailable();
  const selected = mappings.map(mapping => ({ ...mapping }));
  const binary = fileURLToPath(new URL(`./native/boxcompute-service-${process.platform}-${process.arch}`, import.meta.url));
  const child = spawn(binary, ["service-client"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  });
  let exited = false;
  let stopping = false;
  let generation: string | undefined;
  let cleanup: Promise<ServiceCleanup | undefined> | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (stopping || exited) return;
    stopping = true;
    child.stdin.destroy();
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 6_000);
  };
  const closed = new Promise<number | null>(resolve => child.once("close", code => {
    exited = true;
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", stop);
    resolve(code);
  }));
  child.on("error", () => undefined);
  child.stdin.on("error", stop);
  signal?.addEventListener("abort", stop, { once: true });
  const revoke = () => cleanup ??= generation
    ? api.revokeServiceAccess(sandboxId, generation)
    : Promise.resolve(undefined);
  try {
    const bootstrap = await nativeMessage(child, { mappings: selected }, stop);
    const clientKey = bootstrap.client_key;
    if (Object.keys(bootstrap).join() !== "client_key" || typeof clientKey !== "string"
      || !/^nodekey:[0-9a-f]{64}$/.test(clientKey) || /^nodekey:0+$/.test(clientKey)) throw unavailable();
    if (exited || stopping || signal?.aborted) throw unavailable();
    const recipient = generateKeyPairSync("x25519");
    const request: ServiceAccessRequest = {
      operation_id: randomUUID(),
      requested_at: Math.floor(Date.now() / 1_000),
      client_key: clientKey,
      recipient_key: recipient.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
      ports: selected.map(mapping => mapping.remote).sort((left, right) => left - right),
    };
    const result = await api.createServiceAccess(sandboxId, request);
    if (result && uuid.test(result.generation_id)) generation = result.generation_id;
    const configuration = unsealServices(result, recipient.privateKey, request);
    if (exited || stopping || signal?.aborted) throw unavailable();
    const ready = await nativeMessage(child, configuration, stop);
    if (Object.keys(ready).join() !== "ready" || ready.ready !== true || exited || stopping) throw unavailable();
    const completion = closed.then(async code => {
      const cleanup = await revoke();
      if (code !== 0 && !stopping) throw unavailable();
      return cleanup;
    });
    void completion.catch(() => undefined);
    return {
      generationId: result.generation_id,
      expiresAt: result.expires_at,
      closed: completion,
      close: async () => { stop(); return await completion; },
    };
  } catch {
    stop();
    await closed;
    try { await revoke(); } catch { /* fixed error below */ }
    throw unavailable();
  }
}
