// Vendored, byte-identical port of the security-reviewed service session
// implementation from the private BoxCompute repository:
//   boxcompute/sandbox: application/sdk/typescript/src/services.ts
// The only change is service-client binary resolution: the bundled
// ./native/... path is replaced by the BOXCOMPUTE_SERVICE_CLIENT environment
// variable or a digest-pinned GitHub release asset (see below). This copy
// consolidates into @boxcompute/sdk >= 0.3.0 once that package is published;
// keep protocol bytes, validation, and error strings identical until then.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomUUID, type KeyObject } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface ServiceMapping { local: number; remote: number }
export interface ServiceAccessRequest { operation_id: string; requested_at: number; client_key: string; recipient_key: string; ports: number[] }
export interface ServiceAccessResponse { generation_id: string; expires_at: number; sealed: string }
export interface ServiceAccessApi {
  createServiceAccess(request: ServiceAccessRequest): Promise<ServiceAccessResponse>;
  lookupServiceAccess(request: ServiceAccessRequest): Promise<ServiceAccessResponse>;
  revokeServiceAccess(generation: string): Promise<void>;
}
const unavailable = () => new Error("Service access unavailable; no mutation retry was attempted. Unconfirmed access expires at its original deadline.");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Digest-pinned release assets on the public boxcompute/sdk repository. A null
// digest means the release has not been published yet; until it is, callers
// must supply an executable through BOXCOMPUTE_SERVICE_CLIENT.
export const SERVICE_CLIENT_RELEASE_TAG = "service-client-v0";
const SERVICE_CLIENT_DIGESTS: Record<string, string | null> = {
  "boxcompute-proxy-linux-x64": null,
  "boxcompute-proxy-linux-arm64": null,
  "boxcompute-proxy-darwin-x64": null,
  "boxcompute-proxy-darwin-arm64": null,
};

export function serviceClientCacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.BOXCOMPUTE_CACHE_DIR
    ? path.resolve(env.BOXCOMPUTE_CACHE_DIR)
    : path.join(env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : homedir(), "boxcompute");
  return path.join(root, "service-client");
}

async function downloadedServiceClient(asset: string, digest: string, env: NodeJS.ProcessEnv): Promise<string> {
  const directory = serviceClientCacheDirectory(env);
  const target = path.join(directory, asset);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const response = await fetch(
      `https://github.com/boxcompute/sdk/releases/download/${SERVICE_CLIENT_RELEASE_TAG}/${asset}`,
    );
    if (!response.ok) throw unavailable();
    const bytes = Buffer.from(await response.bytes());
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw unavailable();
    await writeFile(temp, bytes, { mode: 0o755, flag: "wx" });
    await chmod(temp, 0o755);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
  return target;
}

async function resolveServiceClientBinary(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const override = env.BOXCOMPUTE_SERVICE_CLIENT;
  if (override) {
    const resolved = path.resolve(override);
    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile() || !(info.mode & 0o111)) {
      throw new Error(`BOXCOMPUTE_SERVICE_CLIENT must point to an existing executable service-client binary (got ${resolved})`);
    }
    return resolved;
  }
  const asset = `boxcompute-proxy-${process.platform}-${process.arch}`;
  const digest = SERVICE_CLIENT_DIGESTS[asset];
  if (digest === undefined) throw unavailable();
  if (digest === null) {
    throw new Error(
      `The pinned service-client release (${SERVICE_CLIENT_RELEASE_TAG}/${asset}) is not published yet. ` +
      "Set BOXCOMPUTE_SERVICE_CLIENT to an existing service-client binary and run `bxc desktop` again.",
    );
  }
  return downloadedServiceClient(asset, digest, env);
}

function nativeMessage(child: ChildProcessByStdio<Writable, Readable, null>, message: object, stop: () => void) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffered = "";
    const cleanup = () => { clearTimeout(timer); child.off("close", failed); child.stdout.off("data", data); };
    const failed = () => { cleanup(); reject(unavailable()); };
    const timer = setTimeout(() => { stop(); failed(); }, 10000);
    const data = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (Buffer.byteLength(buffered) > 4096) { stop(); failed(); return; }
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
    const now = Date.now()/1000;
    if (!value || Object.keys(value).sort().join(",") !== "expires_at,generation_id,sealed" || !uuid.test(value.generation_id)
      || value.expires_at !== request.requested_at+3600 || value.expires_at <= now || value.expires_at > now+3630
      || typeof value.sealed !== "string" || value.sealed.length < 80 || value.sealed.length > 16000) throw unavailable();
    const bytes = Buffer.from(value.sealed,"base64");
    if (bytes.toString("base64") !== value.sealed) throw unavailable();
    const shared = diffieHellman({ privateKey:recipient, publicKey:createPublicKey({ format:"der",type:"spki",
      key:Buffer.concat([Buffer.from("302a300506032b656e032100","hex"),bytes.subarray(0,32)]) }) });
    const secret = Buffer.from(hkdfSync("sha256",shared,Buffer.alloc(0),"boxcompute-connection-v1",32));
    let clear: Buffer;
    try {
      const cipher = createDecipheriv("aes-256-gcm",secret,bytes.subarray(32,44));
      cipher.setAAD(Buffer.from(value.generation_id)); cipher.setAuthTag(bytes.subarray(-16));
      clear=Buffer.concat([cipher.update(bytes.subarray(44,-16)),cipher.final()]);
    } finally { shared.fill(0); secret.fill(0); }
    try {
      const text=new TextDecoder("utf-8",{fatal:true}).decode(clear);
      const inner=JSON.parse(text) as {address:unknown;expires_at:unknown;ports:unknown};
      if (text!==JSON.stringify({address:inner.address,expires_at:inner.expires_at,ports:inner.ports})
        || inner.expires_at!==value.expires_at || JSON.stringify(inner.ports)!==JSON.stringify(request.ports)
        || typeof inner.address!=="string" || inner.address.length>4096 || !/^[A-Za-z0-9_+/:=.-]+$/.test(inner.address)) throw unavailable();
      return {address:inner.address,expires_at:value.expires_at};
    } finally {clear.fill(0);}
  } catch {throw unavailable();}
}

/** Bind every local IPv4-loopback port before issuing one grant. Retain a
 * single native process/client for the complete session; never renew or retry
 * create. API credentials and recipient private keys never enter the child.
 */
export async function openServices(api: ServiceAccessApi, mappings: readonly ServiceMapping[], signal?: AbortSignal) {
  if (signal?.aborted || !["linux","darwin"].includes(process.platform) || !["x64","arm64"].includes(process.arch)
    || mappings.length<1 || mappings.length>8 || mappings.some(m=>Object.keys(m).sort().join(",")!=="local,remote"
      || !Number.isInteger(m.local) || m.local<1 || m.local>65535 || !Number.isInteger(m.remote) || m.remote<1 || m.remote>65535)
    || new Set(mappings.map(m=>m.local)).size!==mappings.length || new Set(mappings.map(m=>m.remote)).size!==mappings.length) throw unavailable();
  const selected=mappings.map(m=>({...m}));
  const binary=await resolveServiceClientBinary();
  const child=spawn(binary,["service-client"],{stdio:["pipe","pipe","ignore"],
    env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR}});
  let exited=false, stopping=false, generation:string|undefined, revocation:Promise<void>|undefined;
  let killTimer:NodeJS.Timeout|undefined;
  const stop=()=>{
    if(stopping || exited) return;
    stopping=true; child.stdin.destroy(); child.kill("SIGTERM");
    killTimer=setTimeout(()=>child.kill("SIGKILL"),6000);
  };
  const closed=new Promise<number|null>(resolve=>child.once("close",code=>{
    exited=true;clearTimeout(killTimer);signal?.removeEventListener("abort",stop);resolve(code);
  }));
  child.on("error",()=>{});
  child.stdin.on("error",stop);
  signal?.addEventListener("abort",stop,{once:true});
  const revoke=()=>revocation??=(generation?api.revokeServiceAccess(generation):Promise.resolve());
  try {
    const bootstrap=await nativeMessage(child,{mappings:selected},stop);
    const clientKey=bootstrap.client_key;
    if(Object.keys(bootstrap).join(",")!=="client_key" || typeof clientKey!=="string" || !/^nodekey:[0-9a-f]{64}$/.test(clientKey) || /^nodekey:0+$/.test(clientKey))throw unavailable();
    if(exited || stopping || signal?.aborted)throw unavailable();
    const recipient=generateKeyPairSync("x25519");
    const request:ServiceAccessRequest={operation_id:randomUUID(),requested_at:Math.floor(Date.now()/1000),client_key:clientKey,
      recipient_key:recipient.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64"),ports:selected.map(m=>m.remote).sort((a,b)=>a-b)};
    const result=await api.createServiceAccess(request);
    if(result && typeof result.generation_id==="string" && uuid.test(result.generation_id)) generation=result.generation_id;
    const configuration=unsealServices(result,recipient.privateKey,request);
    if(exited || stopping || signal?.aborted)throw unavailable();
    const ready=await nativeMessage(child,configuration,stop);
    if(Object.keys(ready).join(",")!=="ready" || ready.ready!==true || exited || stopping)throw unavailable();
    const completion=closed.then(async code=>{await revoke();if(code!==0 && !stopping)throw unavailable();});
    // Consumers may observe completion later; still avoid an unhandled rejection.
    void completion.catch(()=>{});
    return {generationId:result.generation_id,expiresAt:result.expires_at,closed:completion,
      close:async()=>{stop();await completion;}};
  } catch {
    stop();await closed;
    try {await revoke();} catch { /* Report fixed unconfirmed-access error. */ }
    throw unavailable();
  }
}
