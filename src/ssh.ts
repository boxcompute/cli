import { execFile, spawn } from "node:child_process";
import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BoxComputeClient } from "./client.js";

export type CliIo = { stdin: Readable; stdout: Writable; stderr: Writable };

const unavailable = () => new Error(
  "SSH unavailable; mutations are never retried. An unacknowledged enrollment may remain until its server lease expires.",
);
const endpointPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const publicPrefix = Buffer.from("302a300506032b656e032100", "hex");
const rawPublic = (key: KeyObject) => key.export({ format: "der", type: "spki" }).subarray(-32);

function lease(value: unknown, now: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= now || Number(value) > now + 300) throw unavailable();
}

export function unsealSsh(
  value: unknown,
  recipient: KeyObject,
  now = Date.now() / 1000,
): { endpointId: string; expiresAt: number; address: string; hostKey: string } {
  try {
    if (!value || typeof value !== "object") throw unavailable();
    const { endpoint_id: id, expires_at: expiry, sealed } = value as Record<string, unknown>;
    if (
      Object.keys(value).sort().join() !== "endpoint_id,expires_at,sealed" ||
      typeof id !== "string" ||
      !endpointPattern.test(id)
    ) throw unavailable();
    lease(expiry, now);
    if (typeof sealed !== "string" || sealed.length > 12_000 || sealed.length < 80) throw unavailable();
    const bytes = Buffer.from(sealed, "base64");
    if (bytes.toString("base64") !== sealed) throw unavailable();
    const shared = diffieHellman({
      privateKey: recipient,
      publicKey: createPublicKey({
        key: Buffer.concat([publicPrefix, bytes.subarray(0, 32)]),
        format: "der",
        type: "spki",
      }),
    });
    const secret = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "boxcompute-connection-v1", 32));
    let clear: Buffer;
    try {
      const cipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(32, 44));
      cipher.setAAD(Buffer.from(id));
      cipher.setAuthTag(bytes.subarray(-16));
      clear = Buffer.concat([cipher.update(bytes.subarray(44, -16)), cipher.final()]);
    } finally {
      shared.fill(0);
      secret.fill(0);
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(clear);
      const data = JSON.parse(text) as Record<string, unknown>;
      const { address, expires_at: innerExpiry, host_key: hostKey } = data;
      if (text !== JSON.stringify({ address, expires_at: innerExpiry, host_key: hostKey })) throw unavailable();
      lease(innerExpiry, now);
      if (typeof address !== "string" || address.length > 4096 || !/^[A-Za-z0-9_+/:=.-]+$/.test(address)) {
        throw unavailable();
      }
      if (typeof hostKey !== "string" || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(hostKey)) throw unavailable();
      const key = Buffer.from(hostKey.slice(12), "base64");
      if (
        key.length !== 51 ||
        key.toString("base64") !== hostKey.slice(12) ||
        key.readUInt32BE(0) !== 11 ||
        key.subarray(4, 15).toString() !== "ssh-ed25519" ||
        key.readUInt32BE(15) !== 32
      ) throw unavailable();
      return { endpointId: id, expiresAt: Math.min(expiry, innerExpiry), address, hostKey };
    } finally {
      clear.fill(0);
    }
  } catch {
    throw unavailable();
  }
}

async function privateText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 16_384
    ) throw unavailable();
    const bytes = Buffer.alloc(16_385);
    try {
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const token = bytes.subarray(0, bytesRead).toString("utf8").trim();
      if (bytesRead > 16_384 || !token) throw unavailable();
      return token;
    } finally {
      bytes.fill(0);
    }
  } finally {
    await file.close();
  }
}

const proxyWord = (value: string) => `'${value.replaceAll("%", "%%").replaceAll("'", "'\\''")}'`;
const configWord = (value: string) => `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function sshArguments(directory: string, cli = fileURLToPath(new URL("./cli.js", import.meta.url))): string[] {
  const proxy = [process.execPath, cli, "proxy", join(directory, "proxy.json")].map(proxyWord).join(" ");
  return [
    "-F", "/dev/null", "-T",
    "-o", `ProxyCommand=${proxy}`,
    "-o", "HostKeyAlias=boxcompute-endpoint",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${configWord(join(directory, "known_hosts"))}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "KnownHostsCommand=none",
    "-o", "VerifyHostKeyDNS=no",
    "-o", "UpdateHostKeys=no",
    "-o", "HostKeyAlgorithms=ssh-ed25519",
    "-o", "IdentityAgent=none",
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "PreferredAuthentications=publickey",
    "-o", "GSSAPIAuthentication=no",
    "-o", "ForwardX11=no",
    "-o", "ForwardX11Trusted=no",
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "EscapeChar=none",
    "-o", "ConnectTimeout=10",
    "-o", "ConnectionAttempts=1",
    "-o", "LogLevel=QUIET",
    "-i", join(directory, "identity"),
    "sandbox@boxcompute-endpoint",
  ];
}

async function childProcess(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  io?: CliIo,
): Promise<number> {
  if (signal.aborted) throw unavailable();
  return new Promise<number>((resolve) => {
    const child = spawn(binary, args, {
      env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, LANG: "C" },
      detached: true,
      stdio: io ? ["pipe", "pipe", "ignore"] : "ignore",
    });
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const groupSignal = (name: NodeJS.Signals): boolean => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, name);
        return true;
      } catch {
        return false;
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      groupSignal("SIGTERM");
      timer = setTimeout(() => groupSignal("SIGKILL"), 2_200);
    };
    signal.addEventListener("abort", stop, { once: true });
    child.on("error", () => undefined);
    if (io) {
      io.stdin.pipe(child.stdin!);
      child.stdout!.pipe(io.stdout, { end: false });
      child.stdin!.on("error", stop);
      io.stdin.on("error", stop);
      io.stdout.on("error", stop);
      io.stdout.on("close", stop);
    }
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (io) {
        io.stdin.unpipe(child.stdin!);
        child.stdout!.unpipe(io.stdout);
        io.stdin.off("error", stop);
        io.stdout.off("error", stop);
        io.stdout.off("close", stop);
      }
      const finish = () => resolve(code === 0 && !stopped && !signal.aborted ? 0 : 1);
      if (groupSignal("SIGTERM")) setTimeout(() => { groupSignal("SIGKILL"); finish(); }, 2_200);
      else finish();
    });
  });
}

export async function runSsh(
  sandboxId: string,
  action: { reconnect?: boolean; revoke?: string },
  client: BoxComputeClient,
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  if (env.BOXCOMPUTE_ENABLE_SSH !== "1") throw unavailable();
  if (!["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw unavailable();
  if (!/^sbx_[A-Za-z0-9_-]+$/.test(sandboxId) || (action.reconnect && action.revoke)) throw unavailable();
  const endpoint = action.revoke;
  if (endpoint !== undefined && !endpointPattern.test(endpoint)) throw unavailable();

  let directory: string | undefined;
  let endpointId: string | undefined;
  let failed = false;
  let exitCode = 0;
  const abort = new AbortController();
  const stop = () => abort.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let expiryTimer: NodeJS.Timeout | undefined;
  for (const signal of signals) process.on(signal, stop);
  try {
    if (endpoint) {
      await client.revokeCooperativeConnection(sandboxId, endpoint);
      io.stderr.write("Cooperative revocation requested; cleanup remains unconfirmed.\n");
    } else {
      directory = await mkdtemp(join(tmpdir(), "bxc-ssh-"));
      if (/[\r\n\0$]/.test(directory)) throw unavailable();
      const keygenSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]);
      if (
        await childProcess(
          "ssh-keygen",
          ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", join(directory, "identity")],
          env,
          keygenSignal,
        ) !== 0
      ) throw unavailable();
      const sshKey = (await readFile(join(directory, "identity.pub"), "utf8")).trim();
      const binary = fileURLToPath(new URL(`./native/boxcompute-proxy-${process.platform}-${process.arch}`, import.meta.url));
      const keyPath = join(directory, "node.json");
      const generated = await promisify(execFile)(binary, ["keygen", keyPath], {
        timeout: 10_000,
        maxBuffer: 1_024,
        killSignal: "SIGKILL",
        signal: abort.signal,
        env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR },
      });
      const publicResult = JSON.parse(generated.stdout) as { client_key: string };
      const privateResult = JSON.parse(await privateText(keyPath)) as { key: string };
      if (!/^nodekey:[0-9a-f]{64}$/.test(publicResult.client_key) || !/^privkey:[0-9a-f]{64}$/.test(privateResult.key)) {
        throw unavailable();
      }
      const recipient = generateKeyPairSync("x25519");
      const keys = {
        client_key: publicResult.client_key,
        ssh_key: sshKey,
        recipient_key: rawPublic(recipient.publicKey).toString("base64"),
      };
      const result = await client.activateCooperativeConnection(sandboxId, keys);
      if (endpointPattern.test(result.endpoint_id)) endpointId = result.endpoint_id;
      const configuration = unsealSsh(result, recipient.privateKey);
      if (abort.signal.aborted) throw unavailable();
      await writeFile(join(directory, "proxy.json"), JSON.stringify({
        key: privateResult.key,
        address: configuration.address,
        expires_at: new Date(configuration.expiresAt * 1_000).toISOString(),
      }), { mode: 0o600, flag: "wx" });
      await writeFile(
        join(directory, "known_hosts"),
        `boxcompute-endpoint ${configuration.hostKey}\n`,
        { mode: 0o600, flag: "wx" },
      );
      io.stderr.write(`endpointId=${configuration.endpointId} (experimental non-PTY SSH; lease-limited, revoke attempted on exit)\n`);
      expiryTimer = setTimeout(stop, Math.max(0, configuration.expiresAt * 1_000 - Date.now()));
      exitCode = await childProcess("ssh", sshArguments(directory), env, abort.signal, io);
      if (action.reconnect && exitCode === 0 && !abort.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (abort.signal.aborted) throw unavailable();
        const repeatedEnvelope = await client.reconnectCooperativeConnection(
          sandboxId,
          configuration.endpointId,
          keys,
        );
        if (
          repeatedEnvelope.endpoint_id !== result.endpoint_id ||
          repeatedEnvelope.expires_at !== result.expires_at ||
          repeatedEnvelope.sealed !== result.sealed
        ) throw unavailable();
        const repeated = unsealSsh(repeatedEnvelope, recipient.privateKey);
        if (
          repeated.endpointId !== configuration.endpointId ||
          repeated.expiresAt !== configuration.expiresAt ||
          repeated.address !== configuration.address ||
          repeated.hostKey !== configuration.hostKey
        ) throw unavailable();
        exitCode = await childProcess("ssh", sshArguments(directory), env, abort.signal, io);
      }
    }
  } catch {
    failed = true;
  } finally {
    clearTimeout(expiryTimer);
    if (endpointId) {
      try {
        await client.revokeCooperativeConnection(sandboxId, endpointId);
      } catch {
        failed = true;
        io.stderr.write(`Revocation unconfirmed; use bxc sandbox ssh ${sandboxId} --revoke ${endpointId} after checking owner state.\n`);
      }
    }
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } catch {
      failed = true;
    } finally {
      for (const signal of signals) process.off(signal, stop);
    }
  }
  if (failed) throw unavailable();
  return exitCode;
}
