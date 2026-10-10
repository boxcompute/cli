#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { downloadFile, uploadFile } from "./files.js";
import {
  BoxCompute,
  BoxComputeError,
  BoxComputeTransportError,
  type BillingSummary,
  type BillingTransactionPage,
  type AuditEventPage,
  type DeletedSandbox,
  type ExecutionResult,
  type Me,
  type Preview,
  type Sandbox,
  type SandboxAnalytics,
  type SandboxCostDetail,
  type SandboxCostReport,
  type SandboxLogs,
  type Usage,
  type Workspace,
} from "@boxcompute/sdk";
import { buildCreateSandboxRequest, createClient, type SandboxSize } from "./sdk.js";
import { serviceAccessApi } from "./service-access.js";
import {
  clearConnection,
  loadConnection,
  loadSavedUrl,
  saveConnection,
  type Connection,
} from "./config.js";
import {
  HARNESS_IDS,
  detectHarnesses,
  installSkill,
  readSkill,
  removeSkill,
  syncManagedSkills,
  type AgentTarget,
  type HarnessDetection,
} from "./skill.js";
import { openServices, type ServiceMapping } from "./services.js";
import { runProxy } from "./proxy.js";
import { runSsh } from "./ssh.js";
import { cooperativeConnectionApi } from "./cooperative-connection.js";
import { resumeSandbox } from "./resume.js";

const DEFAULT_URL = "https://app.boxcompute.ai";
const CLI_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const rootHelp = `BoxCompute CLI

Usage: bxc [options] [command]

Commands:

  version                         Print the version number and exit
  update                          [alias: up] Update the CLI to the latest npm release
  login                           Log in through BoxCompute in your browser
  logout                          Revoke and remove the saved CLI credential
  auth                            [alias: login] Authentication commands
    logout                        Revoke and remove the saved CLI credential
  doctor                          Verify the saved connection
  whoami                          Show the account and API key behind the saved credential
  credits                         Show remaining credit, settled spending and pending costs
  billing                         Show credits or page wallet transactions
  usage                           Show activity counts for the last 1–90 days
  workspaces                      List workspaces that can own sandboxes
  sandboxes                       [aliases: list, ls] List sandbox instances
  sandbox                         Manage isolated BoxCompute sandboxes
    start                         Create and start a workspace sandbox
    resume                        Start an existing sandbox with its retained files
    status                        Inspect one sandbox
    logs                          Read current or retained sandbox logs
    exec                          Execute a program inside a sandbox
    expose                        Forward selected TCP ports to local loopback
    preview                       Open or close a one-hour browser preview URL
    ssh                           Open experimental lease-limited SSH
    upload                        Upload a local file (up to 8 MiB)
    download                      Download a complete file to a new local path
    analytics                     Read lifecycle, operation, and resource analytics
    costs                         List every charged run of one sandbox
    delete                        [alias: rm] Destroy the runtime; the workspace remains
  deleted                         Read deleted sandboxes, their logs, and their costs
  costs                           Compute cost per API key and per sandbox
  audit                           Page the account's API audit log
  skill                           [alias: skills] Manage coding-harness skills
    detect                        Detect compatible coding harnesses
    list                          [alias: ls] List detected or installed harnesses
    install                       [alias: add] Install the BoxCompute skill
    remove                        [aliases: rm, uninstall] Remove the BoxCompute skill
    info                          [alias: print] Print the packaged skill

Options:

  -V, --version                   Print the version number and exit
  --json                          Emit machine-readable JSON
  -h, --help                      Display help for a command

Login options:

  --url URL                       BoxCompute web URL (default: https://app.boxcompute.ai)
  --no-open                       Print the approval URL without opening a browser

Examples:

  $ bxc login
  $ bxc update
  $ bxc skill detect
  $ bxc skill install
  $ bxc workspaces
  $ bxc sandbox start WORKSPACE_ID
  $ bxc sandbox start WORKSPACE_ID --cpu 2
  $ bxc sandbox start WORKSPACE_ID --size large --idempotency-key SAVED_UNIQUE_KEY
  $ bxc sandbox logs SANDBOX_ID --source execute
  $ bxc sandbox exec SANDBOX_ID -- python -m pytest
  $ bxc sandbox expose SANDBOX_ID --port 3000
  $ bxc sandbox preview SANDBOX_ID --port 3000
  $ bxc costs --from 2026-10-01T00:00:00Z
  $ bxc audit --outcome error
  $ BOXCOMPUTE_ENABLE_SSH=1 bxc sandbox ssh SANDBOX_ID

Compatibility:

  The previous bcompute command remains available as an alias.
`;

const sandboxHelp = `Manage isolated BoxCompute sandboxes

Usage: bxc sandbox <command> [options]

Commands:

  start WORKSPACE_ID              Create and start a new sandbox instance
  resume SANDBOX_ID               Start an existing sandbox; retain its disk and files
  status SANDBOX_ID               Inspect one sandbox
  logs SANDBOX_ID [options]       Read logs without starting the runtime
  exec SANDBOX_ID [options] -- PROGRAM [ARG...]
                                  Execute a program inside a sandbox
  expose SANDBOX_ID --port [LOCAL:]REMOTE
                                  Forward up to 8 TCP ports to 127.0.0.1
  preview SANDBOX_ID --port PORT  Open a one-hour HTTP/WebSocket preview URL for a VM port
  preview SANDBOX_ID --close PREVIEW_ID
                                  Close a preview before it expires
  analytics SANDBOX_ID [options]  Read lifecycle, operation, and resource analytics
  costs SANDBOX_ID                List every charged run with a running estimate
  ssh SANDBOX_ID [options]        Open experimental non-PTY SSH for up to 30 seconds
  delete SANDBOX_ID --yes         [alias: rm] Destroy the runtime; keep the workspace
  upload SANDBOX_ID LOCAL REMOTE  Upload raw bytes under /workspace (up to 8 MiB)
  download SANDBOX_ID REMOTE LOCAL
                                  Download all chunks; refuse an existing local file

Start options:

  --size small|large              VM only: VM profile size (default: small).
                                  small = 0.5 CPU / 1024 MiB; large = 1.5 CPU / 3072 MiB
  --vm                            Explicitly request a VM sandbox; requires
                                  --idempotency-key, reused with the same options on retry
  --gvisor                        Explicitly request a gVisor container sandbox
  --cpu CPU                       gVisor only: scheduler CPU allocation (0.1–4);
                                  implies --gvisor
  --idempotency-key KEY           Required for --vm; reusable for any create
  --name NAME                     Optional sandbox name (1–80 trimmed characters)
  --no-wait                       Return the creation receipt without waiting

  Without --vm or --gvisor, the server's default runtime is selected (VM).
  --size is VM only: gVisor ignores small and rejects large. VM sizing is
  mutually exclusive with --cpu.
  Start waits up to 180 seconds for a pending sandbox to reach running and
  reports its state either way. No automatic retries or replacement VMs.
  Transfers never retry; downloads stop after five minutes and discard partial
  output on failure.

Resume options:

  --idempotency-key KEY           Optional saved retry key for this resume
  --no-wait                       Return the start receipt without waiting

  Resume keeps the existing sandbox ID, disk and files. Running compute resumes
  billing. It waits up to 180 seconds; inspect status after an uncertain response.

Expose options:

  --port [LOCAL:]REMOTE           Repeat for up to 8 unique ports. The local
                                  port defaults to the remote port.

  Expose binds only 127.0.0.1, lasts at most one hour, never renews, and
  attempts to revoke the grant when it exits. Run it again for a new lease.

Preview options:

  --port PORT                     VM port to publish (1–65535)
  --close PREVIEW_ID              Close the preview instead of opening one

  A preview URL is a bearer link: anyone holding it can reach the port until it
  expires after one hour or is closed. Each VM has at most one preview at a time.
  The VM must be owned, running, and network-enabled.

Analytics options:

  --from TIMESTAMP                Window start (RFC 3339)
  --to TIMESTAMP                  Window end (RFC 3339)
  --resolution SECONDS            Bucket width, 60–86400 (default: 300)
  --generation N                  Select one runtime generation

SSH options:

  --reconnect                     Verify one same-envelope reconnect after SSH exits
  --revoke ENDPOINT_ID            Request best-effort cleanup without opening SSH

  Requires BOXCOMPUTE_ENABLE_SSH=1. Available only for operator-enabled
  sandboxes on Linux and macOS (x64 or arm64). Cleanup remains unconfirmed.

Exec options:

  --cwd PATH                      Working directory under /workspace
  --env KEY=VALUE                 Set an environment variable; repeatable
  --timeout SECONDS               Command timeout
  --max-output-bytes BYTES        Maximum captured output

Log options:

  --since TIMESTAMP               Include entries at or after an RFC 3339 time
  --until TIMESTAMP               Include entries before an RFC 3339 time
  --stream stdout|stderr          Filter by output stream
  --source workload|execute|process
                                  Filter by log source
  --limit ENTRIES                 Maximum entries (default: 1000, max: 5000)
`;

const deletedHelp = `Read deleted sandboxes

Usage: bxc deleted <command> [options]

Commands:

  list                            [alias: ls] List deleted sandboxes, newest first
  logs DELETED_ID [options]       Read a deleted sandbox's retained logs
  costs DELETED_ID                List every charged run of a deleted sandbox

  DELETED_ID is the first column of \`bxc deleted list\`, not the sandbox ID.

Log options:

  --runtime RUNTIME               Read an earlier runtime (default: most recent)
  --since TIMESTAMP               Include entries at or after an RFC 3339 time
  --until TIMESTAMP               Include entries before an RFC 3339 time
  --stream stdout|stderr          Filter by output stream
  --source workload|execute|process
                                  Filter by log source
  --limit ENTRIES                 Maximum entries (default: 1000, max: 5000)
`;

const costsHelp = `Compute cost per API key and per sandbox

Usage: bxc costs [options]

Options:

  --from TIMESTAMP                Window start (RFC 3339; default: 30 days ago)
  --to TIMESTAMP                  Window end (RFC 3339; default: now)
  --api-key API_KEY_ID            Restrict to one API key, or \`none\` for
                                  sandboxes not created with an API key

  Settled amounts are exact charges for runs that ended in the window; estimates
  cover runs still in progress. Deleted sandboxes are included. Billing is per
  second with a 60-second minimum per run.
`;

const auditHelp = `Page the account's API audit log, newest first

Usage: bxc audit [options]

Options:

  --type TYPE                     api.request, api_key.created, api_key.revoked,
                                  or api_key.rejected
  --outcome success|error         Filter by request outcome
  --method METHOD                 GET, HEAD, POST, PUT, PATCH, or DELETE
  --api-key API_KEY_ID            Filter by API key
  --resource RESOURCE_ID          Filter by resource, such as a sandbox ID
  --from TIMESTAMP                Window start (RFC 3339)
  --to TIMESTAMP                  Window end (RFC 3339)
  --before CURSOR                 Continue from a previous page's cursor
  --limit EVENTS                  Page size (default: 50, max: 200)
`;

const billingHelp = `Read credits and wallet transactions

Usage: bxc billing [transactions] [options]
       bxc credits

  billing                         Remaining credit and settled spending
  billing transactions            Page verified wallet entries, newest first

Transaction options:
  --from TIMESTAMP                Inclusive RFC 3339 start
  --to TIMESTAMP                  Exclusive RFC 3339 end
  --kind KIND                     Filter by transaction kind
  --bucket cash|promo|plan         Filter by credit bucket
  --before CURSOR                 Cursor from the previous page
  --limit ENTRIES                 Page size (default: 50, max: 200)

Amounts are USD. JSON retains exact integer micro-USD (1000000 = $1).
Available credit is unknown when running compute estimates are unavailable.
Settled spending excludes reservations, running estimates and observed AI costs.
`;

const usageHelp = `Read account activity counts

Usage: bxc usage [--days DAYS]

  --days DAYS                     Window from 1–90 days (default: 30)

Use bxc credits for remaining credit and bxc costs for compute spending.
`;

const skillHelp = `Manage coding-harness skills

Usage: bxc skill <command> [options]

Commands:

  detect                          Detect compatible coding harnesses
  list                            [alias: ls] List detected or installed harnesses
  install [auto|all|HARNESS...]   [alias: add] Install to detected harnesses by default
  remove [auto|all|HARNESS...]    [aliases: rm, uninstall] Remove from detected harnesses
  info                            [alias: print] Print the packaged BoxCompute skill

Install options:

  --force                         Replace a locally modified skill

Remove options:

  --yes                           Confirm removal
  --force                         Remove a locally modified skill

Supported harnesses:
  claude, codex, amp, opencode, cursor, gemini, copilot, cline, roo,
  goose, pi, windsurf, and the shared agents directory
`;

type Io = { stdin?: Readable; stdout: Writable; stderr: Writable };
type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type CliDependencies = {
  env?: NodeJS.ProcessEnv;
  io?: Io;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  openBrowser?: (url: string) => void;
  installUpdate?: (version: string) => Promise<void>;
  loadConnection?: (env: NodeJS.ProcessEnv) => Promise<Connection>;
  loadSavedUrl?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  saveConnection?: (url: string, token: string, env: NodeJS.ProcessEnv) => Promise<void>;
  clearConnection?: (env: NodeJS.ProcessEnv) => Promise<void>;
  detectHarnesses?: typeof detectHarnesses;
  installSkill?: typeof installSkill;
  removeSkill?: typeof removeSkill;
  readSkill?: typeof readSkill;
  syncManagedSkills?: typeof syncManagedSkills;
  openServices?: typeof openServices;
  proxy?: typeof runProxy;
  ssh?: typeof runSsh;
};

class UsageError extends Error {
  constructor(message: string) { super(message); this.name = "UsageError"; }
}

type BrowserRuntime = {
  env?: NodeJS.ProcessEnv;
  kernelRelease?: string;
  spawn?: typeof spawn;
  system?: NodeJS.Platform;
};

export function browserLaunch(
  url: string,
  runtime: Pick<BrowserRuntime, "env" | "kernelRelease" | "system"> = {},
): { command: string; args: string[]; detached: boolean } {
  const system = runtime.system ?? platform();
  const env = runtime.env ?? process.env;
  const kernelRelease = runtime.kernelRelease ?? release();
  const isWsl = system === "linux" && Boolean(
    env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(kernelRelease),
  );

  if (isWsl) return { command: "explorer.exe", args: [url], detached: false };
  if (system === "darwin") return { command: "open", args: [url], detached: true };
  if (system === "win32") return { command: "cmd", args: ["/c", "start", "", url], detached: true };
  return { command: "xdg-open", args: [url], detached: true };
}

export function openBrowser(url: string, runtime: BrowserRuntime = {}): void {
  const launch = browserLaunch(url, runtime);
  try {
    const child = (runtime.spawn ?? spawn)(launch.command, launch.args, {
      detached: launch.detached,
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The approval URL is always printed before this best-effort launch. Keep
    // polling so headless shells and restricted WSL interop can authenticate.
  }
}

function releaseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number) as [number, number, number];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareReleaseVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

async function installCliUpdate(version: string): Promise<void> {
  const executable = platform() === "win32" ? "npm.cmd" : "npm";
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, ["install", "--global", `@boxcompute/cli@${version}`], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm exited with code ${code ?? "unknown"}`));
    });
  });
}

async function updateCli(dependencies: {
  fetch: typeof fetch;
  install: (version: string) => Promise<void>;
  io: Io;
  json: boolean;
}): Promise<number> {
  let response: Response;
  try {
    response = await dependencies.fetch("https://registry.npmjs.org/%40boxcompute%2Fcli/latest", {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new Error(`Could not check npm for updates: ${(error as Error)?.message ?? String(error)}`);
  }
  if (!response.ok) throw new Error(`Could not check npm for updates (HTTP ${response.status})`);

  const latest = (await response.json() as { version?: unknown }).version;
  const currentParts = releaseVersion(CLI_VERSION);
  const latestParts = releaseVersion(latest);
  if (!currentParts || !latestParts || typeof latest !== "string") {
    throw new Error("npm returned an invalid BoxCompute CLI version");
  }
  if (compareReleaseVersions(latestParts, currentParts) <= 0) {
    emit(
      dependencies.io,
      dependencies.json,
      { updated: false, version: CLI_VERSION },
      `BoxCompute CLI is already up to date (${CLI_VERSION}).\n`,
    );
    return 0;
  }

  write(dependencies.io.stderr, `Updating BoxCompute CLI from ${CLI_VERSION} to ${latest}…\n`);
  try {
    await dependencies.install(latest);
  } catch (error) {
    throw new Error(
      `Could not install @boxcompute/cli@${latest}: ${(error as Error)?.message ?? String(error)}. ` +
      `Run \`npm install --global @boxcompute/cli@${latest}\` manually.`,
    );
  }
  emit(
    dependencies.io,
    dependencies.json,
    { updated: true, previousVersion: CLI_VERSION, version: latest },
    `Updated BoxCompute CLI to ${latest}.\n`,
  );
  return 0;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const write = (stream: NodeJS.WritableStream, value: string) => { stream.write(value); };
const emit = (io: Io, json: boolean, value: unknown, human: string) => {
  write(io.stdout, json ? `${JSON.stringify(value)}\n` : human);
};

function option(tokens: string[], name: string): string | undefined {
  const index = tokens.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = tokens[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`--${name} requires a value`);
  tokens.splice(index, 2);
  return value;
}

function flag(tokens: string[], name: string): boolean {
  const index = tokens.indexOf(`--${name}`);
  if (index < 0) return false;
  tokens.splice(index, 1);
  return true;
}

function globalFlag(tokens: string[], ...names: string[]): boolean {
  const separator = tokens.indexOf("--");
  const boundary = separator < 0 ? tokens.length : separator;
  const index = tokens.findIndex((token, position) => position < boundary && names.includes(token));
  if (index < 0) return false;
  tokens.splice(index, 1);
  return true;
}

function positive(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new UsageError(`${name} must be a positive integer`);
  return parsed;
}

export function serviceMappings(tokens: string[]): ServiceMapping[] {
  const mappings: ServiceMapping[] = [];
  while (tokens.includes("--port")) {
    const raw = option(tokens, "port")!;
    const parts = raw.split(":");
    if (parts.length > 2 || parts.some(part => !/^\d+$/.test(part))) {
      throw new UsageError("--port must be REMOTE or LOCAL:REMOTE");
    }
    const local = Number(parts[0]);
    const remote = Number(parts.length === 1 ? parts[0] : parts[1]);
    if (![local, remote].every(port => Number.isSafeInteger(port) && port >= 1 && port <= 65_535)) {
      throw new UsageError("--port values must be integers from 1 to 65535");
    }
    mappings.push({ local, remote });
  }
  if (mappings.length < 1 || mappings.length > 8) throw new UsageError("sandbox expose requires 1 to 8 --port options");
  if (new Set(mappings.map(mapping => mapping.local)).size !== mappings.length) throw new UsageError("Local ports must be unique");
  if (new Set(mappings.map(mapping => mapping.remote)).size !== mappings.length) throw new UsageError("Remote ports must be unique");
  return mappings;
}

function schedulerCpu(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 4) {
    throw new UsageError("--cpu must be a number from 0.1 to 4");
  }
  return parsed;
}

function timestamp(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new UsageError(`${name} must be an RFC 3339 timestamp`);
  return parsed.toISOString();
}

function oneOf<const T extends string>(
  value: string | undefined,
  name: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) throw new UsageError(`${name} must be one of: ${values.join(", ")}`);
  return value as T;
}

function environment(tokens: string[]): Record<string, string> | undefined {
  const values: string[] = [];
  for (;;) {
    const index = tokens.indexOf("--env");
    if (index < 0) break;
    const value = tokens[index + 1];
    if (!value) throw new UsageError("--env requires KEY=VALUE");
    values.push(value);
    tokens.splice(index, 2);
  }
  if (!values.length) return undefined;
  return Object.fromEntries(values.map((value) => {
    const at = value.indexOf("=");
    if (at < 1) throw new UsageError("--env requires KEY=VALUE");
    return [value.slice(0, at), value.slice(at + 1)];
  }));
}

async function deviceRequest<T>(
  url: string,
  pathname: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(new URL(pathname, `${url}/`), init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
    throw new BoxComputeError({
      status: response.status,
      code: body.code ?? "HTTP_ERROR",
      message: body.error ?? `BoxCompute returned HTTP ${response.status}`,
    });
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

async function authenticate(args: string[], dependencies: Required<Pick<CliDependencies,
  "fetch" | "now" | "sleep" | "openBrowser" | "loadSavedUrl" | "saveConnection"
>> & { env: NodeJS.ProcessEnv; io: Io; json: boolean }): Promise<number> {
  const url = option(args, "url") ?? await dependencies.loadSavedUrl(dependencies.env) ?? DEFAULT_URL;
  const noOpen = flag(args, "no-open");
  if (args.length) throw new UsageError(`Unexpected auth argument: ${args[0]}`);
  let started: DeviceAuthorization;
  try {
    started = await deviceRequest<DeviceAuthorization>(url, "/api/cli-auth/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: `${hostname()} (${platform()})` }),
    }, dependencies.fetch);
  } catch (error) {
    if (error instanceof BoxComputeError && [401, 404, 405].includes(error.status)) {
      throw new Error(
        `Browser login is not available at ${url} (HTTP ${error.status}). ` +
        "The BoxCompute server must be updated to support CLI authentication. " +
        "For a local or self-hosted server, run `bxc login --url WEB_URL`.",
      );
    }
    throw error;
  }
  const verificationUrl = new URL(started.verificationUriComplete);
  if (
    verificationUrl.origin !== new URL(url).origin ||
    !started.deviceCode.startsWith("bcd_") ||
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(started.userCode) ||
    !Number.isFinite(started.expiresIn) ||
    started.expiresIn <= 0 ||
    !Number.isFinite(started.interval) ||
    started.interval <= 0
  ) {
    throw new Error("BoxCompute returned an invalid browser authentication response");
  }

  write(dependencies.io.stderr, `\nOpen this URL to authenticate:\n${verificationUrl.href}\n\nCode: ${started.userCode}\n\n`);
  if (!noOpen) dependencies.openBrowser(verificationUrl.href);
  write(dependencies.io.stderr, "Waiting for browser approval…\n");

  const deadline = dependencies.now() + started.expiresIn * 1000;
  while (dependencies.now() < deadline) {
    await dependencies.sleep(Math.max(1, started.interval) * 1000);
    try {
      const result = await deviceRequest<{ token: string }>(url, "/api/cli-auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: started.deviceCode }),
      }, dependencies.fetch);
      await dependencies.saveConnection(url, result.token, dependencies.env);
      emit(dependencies.io, dependencies.json, { authenticated: true, url }, `Authenticated with ${url}.\nNext: bxc skill install\n`);
      return 0;
    } catch (error) {
      if (error instanceof BoxComputeError && error.status === 428 && error.message === "authorization_pending") continue;
      if (error instanceof BoxComputeError && error.status === 410) throw new Error("Browser authentication expired. Run `bxc auth` again.");
      throw error;
    }
  }
  throw new Error("Browser authentication expired. Run `bxc auth` again.");
}

function sandboxLine(sandbox: Sandbox): string {
  return `${sandbox.id}\t${sandbox.state}\t${sandbox.name}\n`;
}

const SANDBOX_READY_TIMEOUT_MS = 180_000;
const SANDBOX_READY_POLL_MS = 3_000;

async function awaitRunning(
  client: BoxCompute,
  id: string,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
): Promise<{ sandbox: Sandbox; timedOut: boolean }> {
  const deadline = now() + SANDBOX_READY_TIMEOUT_MS;
  for (;;) {
    await sleep(SANDBOX_READY_POLL_MS);
    const sandbox = await client.sandboxes.inspect(id);
    if (sandbox.state === "running" || sandbox.state === "expired") return { sandbox, timedOut: false };
    if (now() >= deadline) return { sandbox, timedOut: true };
  }
}

function workspaceLine(workspace: Workspace): string {
  return `${workspace.id}\t${workspace.name}\n`;
}

function executionOutput(io: Io, json: boolean, sandboxId: string, result: ExecutionResult): number {
  if (json) emit(io, true, { sandboxId, ...result }, "");
  else {
    write(io.stdout, result.stdout);
    write(io.stderr, result.stderr);
    write(io.stderr, `sandbox=${sandboxId} exitCode=${result.exitCode} timedOut=${result.timedOut}\n`);
  }
  return result.exitCode;
}

function logsOutput(io: Io, json: boolean, logs: SandboxLogs): number {
  if (json) {
    emit(io, true, { logs }, "");
    return 0;
  }
  if (!logs.entries.length) write(io.stdout, "No logs found.\n");
  for (const entry of logs.entries) {
    write(io.stdout, `${entry.timestamp}\t${entry.stream}\t${entry.source}\t${entry.message}\n`);
  }
  write(
    io.stderr,
    `sandbox=${logs.sandboxId} entries=${logs.entries.length} retentionSeconds=${logs.retention_seconds}` +
      `${logs.truncated ? " truncated=true" : ""}\n`,
  );
  return 0;
}

const isoTime = (milliseconds: number | null | undefined) =>
  milliseconds === null || milliseconds === undefined ? "-" : new Date(milliseconds).toISOString();
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;

function billingOutput(io: Io, json: boolean, billing: BillingSummary): number {
  const available = billing.balance.availableMicros === null ? "Unavailable" : usd(billing.balance.availableMicros);
  const running = billing.activeEstimate.amountMicros === null ? "Unavailable" : usd(billing.activeEstimate.amountMicros);
  emit(io, json, { billing },
    `Available credit\t${available}\nWallet balance\t${usd(billing.balance.totalMicros)}\n` +
    `Reserved\t${usd(billing.balance.reservedMicros)}\nRunning compute estimate\t${running}\n` +
    `Settled spending\t${usd(billing.settledUsage.totalMicros)}\n` +
    `  AI\t${usd(billing.settledUsage.aiMicros)}\n  Compute\t${usd(billing.settledUsage.sandboxMicros)}\n` +
    `Account\t${billing.accountStatus}\nAI billing\t${billing.modelBillingMode}\n`);
  if (!json && billing.activeEstimate.status === "unavailable")
    write(io.stderr, "Running compute estimates are unavailable; spendable credit is unknown.\n");
  return 0;
}

function transactionsOutput(io: Io, json: boolean, page: BillingTransactionPage): number {
  if (json) { emit(io, true, page, ""); return 0; }
  if (!page.transactions.length) write(io.stdout, "No wallet transactions found.\n");
  for (const entry of page.transactions) {
    const amount = `${entry.amountMicros < 0 ? "-" : "+"}${usd(Math.abs(entry.amountMicros))}`;
    const description = entry.description.replace(/[\x00-\x1f\x7f]/g, " ");
    write(io.stdout, `${isoTime(entry.createdAt)}\t${entry.id}\t${entry.kind}\t${entry.bucket}\t${amount}\t${description}\n`);
  }
  if (page.nextCursor) write(io.stderr, `More transactions: bxc billing transactions --before ${page.nextCursor}\n`);
  return 0;
}

function usageOutput(io: Io, json: boolean, usage: Usage): number {
  emit(io, json, { usage }, `Since\t${isoTime(usage.since)}\nOperations\t${usage.operations}\n` +
    `Executions\t${usage.executions}\nExecution time (ms)\t${usage.executionTimeMs}\n` +
    `Output bytes\t${usage.outputBytes}\nFailed operations\t${usage.failedOperations}\n` +
    `Agent runs\t${usage.agentRuns}\nTool calls\t${usage.toolCalls}\n` +
    `Active sandboxes\t${usage.activeSandboxes}\nSandbox slots\t${usage.sandboxSlots}\n`);
  return 0;
}

function meOutput(io: Io, json: boolean, me: Me): number {
  const identity = me.account.email ?? me.account.name ?? me.account.id;
  emit(
    io,
    json,
    me,
    `${identity}\taccount=${me.account.id}\n` +
      `API key ${me.apiKey.name}\t${me.apiKey.id}\tscopes=${me.apiKey.scopes.join(",")}\n`,
  );
  return 0;
}

function costReportOutput(io: Io, json: boolean, report: SandboxCostReport): number {
  if (json) {
    emit(io, true, { costs: report }, "");
    return 0;
  }
  if (!report.sandboxes.length) write(io.stdout, "No charged sandbox runs in this window.\n");
  for (const item of report.sandboxes) {
    write(
      io.stdout,
      `${item.sandboxId}\t${item.name}\truns=${item.runs}\tbillableSeconds=${item.billableSeconds}` +
        `\tsettled=${usd(item.settledMicros)}\testimated=${usd(item.estimatedMicros)}` +
        `${item.deleted ? "\tdeleted" : ""}\n`,
    );
  }
  write(
    io.stderr,
    `window=${isoTime(report.from)}..${isoTime(report.to)} runs=${report.totals.runs}` +
      ` settled=${usd(report.totals.settledMicros)} estimated=${usd(report.totals.estimatedMicros)}` +
      ` estimates=${report.estimates}\n`,
  );
  return 0;
}

function costDetailOutput(io: Io, json: boolean, detail: SandboxCostDetail): number {
  if (json) {
    emit(io, true, { costs: detail }, "");
    return 0;
  }
  if (!detail.runs.length && !detail.running.length) write(io.stdout, "No charged runs.\n");
  for (const run of detail.runs) {
    write(
      io.stdout,
      `${isoTime(run.startedAt)}\t${isoTime(run.endedAt)}\tbillableSeconds=${run.billableSeconds}\t${usd(run.amountMicros)}\n`,
    );
  }
  for (const run of detail.running) {
    write(
      io.stdout,
      `${isoTime(run.startedAt)}\trunning\tbillableSeconds=${run.billableSeconds}\t~${usd(run.estimatedMicros)}\n`,
    );
  }
  write(
    io.stderr,
    `sandbox=${detail.sandbox.sandboxId} runs=${detail.sandbox.runs} settled=${usd(detail.sandbox.settledMicros)}` +
      ` estimated=${usd(detail.sandbox.estimatedMicros)}${detail.truncated ? " truncated=true" : ""}\n`,
  );
  return 0;
}

function auditOutput(io: Io, json: boolean, page: AuditEventPage): number {
  if (json) {
    emit(io, true, page, "");
    return 0;
  }
  if (!page.events.length) write(io.stdout, "No audit events found.\n");
  for (const event of page.events) {
    const request = event.request
      ? `${event.request.method} ${event.request.path}\t${event.request.status}`
      : "-\t-";
    write(io.stdout, `${isoTime(event.createdAt)}\t${event.type}\t${request}\t${event.resourceId ?? "-"}\n`);
  }
  if (page.nextCursor) write(io.stderr, `More events: bxc audit --before ${page.nextCursor}\n`);
  return 0;
}

function deletedLine(sandbox: DeletedSandbox): string {
  return `${sandbox.id}\t${sandbox.sandboxId}\t${sandbox.name}\tdeleted=${isoTime(sandbox.deletedAt)}\n`;
}

function analyticsOutput(io: Io, json: boolean, analytics: SandboxAnalytics): number {
  if (json) {
    emit(io, true, { analytics }, "");
    return 0;
  }
  for (const generation of analytics.generations) {
    write(
      io.stdout,
      `generation=${generation.generation}\t${generation.runtimeClass}\tstarted=${isoTime(generation.startedAt)}` +
        `\tstopped=${isoTime(generation.stoppedAt)}\n`,
    );
  }
  const totals = analytics.operations.reduce(
    (sum, bucket) => ({
      operations: sum.operations + bucket.operations,
      executions: sum.executions + bucket.executions,
      failures: sum.failures + bucket.failures,
    }),
    { operations: 0, executions: 0, failures: 0 },
  );
  write(
    io.stdout,
    `operations=${totals.operations}\texecutions=${totals.executions}\tfailures=${totals.failures}\n`,
  );
  write(
    io.stderr,
    `sandbox=${analytics.sandboxId} window=${isoTime(analytics.from)}..${isoTime(analytics.to)}` +
      ` resolutionSeconds=${analytics.resolutionSeconds} resources=${analytics.resources.status}` +
      ` (use --json for time series)\n`,
  );
  return 0;
}

function previewOutput(io: Io, json: boolean, preview: Preview): number {
  emit(io, json, { preview }, `${preview.url}\n`);
  if (!json) {
    write(
      io.stderr,
      `Preview ${preview.previewId} for port ${preview.port} expires at ${preview.expiresAt}. ` +
        `Anyone with the URL can reach it; close it sooner with ` +
        `'bxc sandbox preview ${preview.sandboxId} --close ${preview.previewId}'.\n`,
    );
  }
  return 0;
}

function logFilters(args: string[]) {
  const since = timestamp(option(args, "since"), "--since");
  const until = timestamp(option(args, "until"), "--until");
  const stream = oneOf(option(args, "stream"), "--stream", ["stdout", "stderr"] as const);
  const source = oneOf(option(args, "source"), "--source", ["workload", "execute", "process"] as const);
  const limit = positive(option(args, "limit"), "--limit");
  if (limit !== undefined && limit > 5_000) throw new UsageError("--limit must be 5000 or fewer");
  if (since && until && since >= until) throw new UsageError("--since must be earlier than --until");
  return { since, until, stream, source, limit };
}

function timeWindow(args: string[]) {
  const from = timestamp(option(args, "from"), "--from");
  const to = timestamp(option(args, "to"), "--to");
  if (from && to && from >= to) throw new UsageError("--from must be earlier than --to");
  return { from, to };
}

export async function runCli(argv: string[], supplied: CliDependencies = {}): Promise<number> {
  const env = supplied.env ?? process.env;
  const io: Io = supplied.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  const fetchImpl = supplied.fetch ?? fetch;
  const now = supplied.now ?? Date.now;
  const sleep = supplied.sleep ?? delay;
  const openBrowserImpl = supplied.openBrowser ?? openBrowser;
  const installUpdate = supplied.installUpdate ?? installCliUpdate;
  const load = supplied.loadConnection ?? loadConnection;
  const savedUrl = supplied.loadSavedUrl ?? loadSavedUrl;
  const save = supplied.saveConnection ?? saveConnection;
  const clear = supplied.clearConnection ?? clearConnection;
  const detect = supplied.detectHarnesses ?? detectHarnesses;
  const install = supplied.installSkill ?? installSkill;
  const remove = supplied.removeSkill ?? removeSkill;
  const skillText = supplied.readSkill ?? readSkill;
  const syncSkills = supplied.syncManagedSkills ?? syncManagedSkills;
  const expose = supplied.openServices ?? openServices;
  const proxy = supplied.proxy ?? runProxy;
  const ssh = supplied.ssh ?? runSsh;
  const streamIo = { stdin: io.stdin ?? process.stdin, stdout: io.stdout, stderr: io.stderr };
  const args = [...argv];
  const json = globalFlag(args, "--json");
  const versionRequested = args[0] === "version" || globalFlag(args, "--version", "-V", "-v");
  if (versionRequested) {
    emit(io, json, { version: CLI_VERSION }, `${CLI_VERSION}\n`);
    return 0;
  }
  const helpRequested = globalFlag(args, "--help", "-h");
  if (!args.length || args[0] === "help" || helpRequested) {
    const helpTarget = args[0] === "help" ? args[1] : args[0];
    write(io.stdout, helpFor(helpTarget));
    return 0;
  }

  let command = args.shift();
  if (command === "login") command = "auth";
  if (command === "up") command = "update";
  if (command === "skills") command = "skill";
  if (command === "list" || command === "ls") command = "sandboxes";

  if (command === "proxy") {
    if (json || args.length !== 1) throw new UsageError("proxy requires one private configuration file and no --json option");
    return proxy(args[0]!, streamIo);
  }

  const canAutoSync = supplied.syncManagedSkills !== undefined || supplied.env === undefined ||
    Boolean(env.HOME || env.USERPROFILE);
  if (command !== "skill" && canAutoSync) {
    try {
      const synced = await syncSkills(env);
      const updated = synced.filter((item) => item.status === "updated");
      const modified = synced.filter((item) => item.status === "modified");
      if (updated.length) {
        write(
          io.stderr,
          `Updated the BoxCompute skill for ${updated.flatMap((item) => item.agents).join(", ")}. ` +
          "Start a new agent session to load it.\n",
        );
      }
      for (const item of modified) {
        write(
          io.stderr,
          `Kept locally modified BoxCompute skill at ${item.path}; run ` +
          "`bxc skill install --force` to replace it.\n",
        );
      }
    } catch (error) {
      write(
        io.stderr,
        `Could not check installed BoxCompute skills: ${(error as Error)?.message ?? String(error)}\n`,
      );
    }
  }

  if (command === "logout") {
    if (args.length) throw new UsageError("logout takes no options");
    const connection = await load(env);
    await createClient(connection, fetchImpl).auth.revoke();
    await clear(env);
    emit(io, json, { authenticated: false }, "BoxCompute CLI credential revoked and removed.\n");
    return 0;
  }

  if (command === "auth") {
    if (args[0] === "login") args.shift();
    if (args[0] === "logout") {
      args.shift();
      if (args.length) throw new UsageError("auth logout takes no options");
      const connection = await load(env);
      await createClient(connection, fetchImpl).auth.revoke();
      await clear(env);
      emit(io, json, { authenticated: false }, "BoxCompute CLI credential revoked and removed.\n");
      return 0;
    }
    return authenticate(args, { env, io, json, fetch: fetchImpl, now, sleep, openBrowser: openBrowserImpl, loadSavedUrl: savedUrl, saveConnection: save });
  }

  if (command === "update") {
    if (args.length) throw new UsageError("update takes no options");
    return updateCli({ fetch: fetchImpl, install: installUpdate, io, json });
  }

  if (command === "skill") {
    let action = args.shift();
    if (!action) {
      write(io.stdout, skillHelp);
      return 0;
    }
    if (action === "ls") action = "list";
    if (action === "add") action = "install";
    if (action === "rm" || action === "uninstall") action = "remove";
    if (action === "print") action = "info";
    if (action === "detect") {
      if (args.length) throw new UsageError("skill detect takes no options");
      const harnesses = (await detect(env)).filter((item) => item.detected);
      emit(
        io,
        json,
        { harnesses },
        harnesses.length
          ? `Detected coding harnesses:\n${harnesses.map(harnessLine).join("")}\nRun \`bxc skill install\` to install automatically.\n`
          : "No supported coding harnesses detected. You can name one explicitly or use `bxc skill install all`.\n",
      );
      return 0;
    }
    if (action === "list") {
      if (args.length) throw new UsageError("skill list takes no options");
      const harnesses = (await detect(env)).filter((item) => item.detected || item.installed);
      emit(
        io,
        json,
        { harnesses },
        harnesses.length
          ? `Coding harness skills:\n${harnesses.map(harnessLine).join("")}`
          : "No supported coding harnesses detected and no BoxCompute skills installed.\n",
      );
      return 0;
    }
    if (action === "info") {
      if (args.length) throw new UsageError("skill info takes no options");
      write(io.stdout, await skillText());
      return 0;
    }
    if (action !== "install" && action !== "remove") {
      throw new UsageError("skill requires `detect`, `list`, `install`, `remove`, or `info`");
    }
    const force = flag(args, "force");
    const confirmed = flag(args, "yes");
    const targets = (args.length ? args : ["auto"]) as AgentTarget[];
    const supported = new Set<AgentTarget>([...HARNESS_IDS, "auto", "all", "both"]);
    const invalid = targets.find((target) => !supported.has(target));
    if (invalid) throw new UsageError(`Unknown coding harness: ${invalid}`);
    if (action === "remove") {
      if (!confirmed) throw new UsageError("skill remove requires --yes");
      const removed = await remove(targets, { force, env });
      emit(io, json, { removed }, `${removed.map((item) => `${removalStatus(item.status)} for ${item.agents.join(", ")}: ${item.path}`).join("\n")}\n`);
      return 0;
    }
    if (confirmed) throw new UsageError("--yes is only valid with skill remove");
    const installed = await install(targets, { force, env });
    emit(io, json, { installed }, `${installed.map((item) => `${skillStatus(item.status)} for ${item.agents.join(", ")}: ${item.path}`).join("\n")}\n`);
    return 0;
  }

  if (command === "sandbox" && !args.length) {
    write(io.stdout, sandboxHelp);
    return 0;
  }
  if (command === "deleted" && !args.length) args.push("list");

  const connection = await load(env);
  const client = createClient(connection, fetchImpl);
  if (command === "doctor") {
    const sandboxes = await client.sandboxes.list();
    emit(io, json, { connected: true, url: connection.url, sandboxes: sandboxes.length }, `Connected to ${connection.url} · ${sandboxes.length} sandbox${sandboxes.length === 1 ? "" : "es"}\n`);
    return 0;
  }
  if (command === "sandboxes") {
    if (args.length) throw new UsageError("sandboxes takes no options");
    const sandboxes = await client.sandboxes.list();
    emit(io, json, { sandboxes }, sandboxes.length ? sandboxes.map(sandboxLine).join("") : "No sandboxes found. Start one for a BoxCompute workspace first.\n");
    return 0;
  }
  if (command === "whoami") {
    if (args.length) throw new UsageError("whoami takes no options");
    return meOutput(io, json, await client.me.get());
  }
  if (command === "credits" || command === "billing") {
    if (command === "credits" || !args.length) {
      if (args.length) throw new UsageError("credits takes no options");
      return billingOutput(io, json, await client.billing.get());
    }
    if (args.shift() !== "transactions") throw new UsageError("billing requires transactions or no arguments");
    const window = timeWindow(args);
    const kind = option(args, "kind");
    const bucket = oneOf(option(args, "bucket"), "--bucket", ["cash", "promo", "plan"] as const);
    const before = option(args, "before");
    const limit = positive(option(args, "limit"), "--limit");
    if (limit !== undefined && limit > 200) throw new UsageError("--limit must be 200 or fewer");
    if (args.length) throw new UsageError(`Unknown billing transactions option: ${args[0]}`);
    return transactionsOutput(io, json, await client.billing.transactions({ ...window, kind, bucket, before, limit }));
  }
  if (command === "usage") {
    const days = positive(option(args, "days"), "--days") ?? 30;
    if (days > 90) throw new UsageError("--days must be 90 or fewer");
    if (args.length) throw new UsageError(`Unknown usage option: ${args[0]}`);
    return usageOutput(io, json, await client.usage.get(days));
  }
  if (command === "costs") {
    const window = timeWindow(args);
    const apiKeyId = option(args, "api-key");
    if (args.length) throw new UsageError(`Unknown costs option: ${args[0]}`);
    return costReportOutput(io, json, await client.costs.sandboxes({ ...window, apiKeyId }));
  }
  if (command === "audit") {
    const type = oneOf(option(args, "type"), "--type", [
      "api.request", "api_key.created", "api_key.revoked", "api_key.rejected",
    ] as const);
    const outcome = oneOf(option(args, "outcome"), "--outcome", ["success", "error"] as const);
    const method = oneOf(option(args, "method"), "--method", ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const);
    const apiKeyId = option(args, "api-key");
    const resourceId = option(args, "resource");
    const before = option(args, "before");
    const limit = positive(option(args, "limit"), "--limit");
    if (limit !== undefined && limit > 200) throw new UsageError("--limit must be 200 or fewer");
    const window = timeWindow(args);
    if (args.length) throw new UsageError(`Unknown audit option: ${args[0]}`);
    return auditOutput(io, json, await client.auditEvents.list({
      type, outcome, method, apiKeyId, resourceId, before, limit, ...window,
    }));
  }
  if (command === "deleted") {
    let action = args.shift();
    if (action === "ls") action = "list";
    if (action === "list") {
      if (args.length) throw new UsageError("deleted list takes no options");
      const deleted = await client.deletedSandboxes.list();
      emit(io, json, { deletedSandboxes: deleted }, deleted.length ? deleted.map(deletedLine).join("") : "No deleted sandboxes found.\n");
      return 0;
    }
    const id = args.shift();
    if (!id || (action !== "logs" && action !== "costs")) {
      throw new UsageError("deleted requires `list`, `logs DELETED_ID`, or `costs DELETED_ID`");
    }
    if (action === "costs") {
      if (args.length) throw new UsageError("deleted costs takes one deleted sandbox ID");
      return costDetailOutput(io, json, await client.deletedSandboxes.costs(id));
    }
    const runtime = option(args, "runtime");
    const filters = logFilters(args);
    if (args.length) throw new UsageError(`Unknown deleted logs option: ${args[0]}`);
    return logsOutput(io, json, await client.deletedSandboxes.logs(id, { ...filters, runtime }));
  }
  if (command === "workspaces") {
    if (args.length) throw new UsageError("workspaces takes no options");
    const workspaces = await client.workspaces.list();
    emit(io, json, { workspaces }, workspaces.length ? workspaces.map(workspaceLine).join("") : "No workspaces found. Create one in BoxCompute first.\n");
    return 0;
  }
  if (command !== "sandbox") throw new UsageError(`Unknown command: ${command}`);

  let action = args.shift();
  if (action === "rm") action = "delete";
  const id = args.shift();
  if (!action || !id) throw new UsageError("sandbox requires an action and sandbox ID");
  if (action === "resume") {
    const key = option(args, "idempotency-key");
    const noWait = flag(args, "no-wait");
    if (args.length) throw new UsageError(`Unknown sandbox resume option: ${args[0]}`);
    let sandbox = await resumeSandbox(connection, fetchImpl, id, key);
    if (sandbox.state === "pending" && !noWait) {
      write(io.stderr, `Sandbox ${id} is pending; waiting up to ${SANDBOX_READY_TIMEOUT_MS / 1000} seconds for running...\n`);
      sandbox = (await awaitRunning(client, id, sleep, now)).sandbox;
    }
    emit(io, json, { sandbox }, sandboxLine(sandbox));
    if (sandbox.state !== "running") write(io.stderr, "Resume receipt only. Inspect this sandbox's status before retrying.\n");
    return sandbox.state === "running" || (noWait && sandbox.state === "pending") ? 0 : 1;
  }
  if (action === "start") {
    const cpu = schedulerCpu(option(args, "cpu"));
    const vmSandbox = flag(args, "vm");
    const gvisor = flag(args, "gvisor");
    const size: SandboxSize = oneOf(option(args, "size"), "--size", ["small", "large"] as const) ?? "small";
    const idempotencyKey = option(args, "idempotency-key");
    const name = option(args, "name");
    const noWait = flag(args, "no-wait");
    if (args.length) throw new UsageError(`Unknown sandbox start option: ${args[0]}`);
    if (vmSandbox && gvisor) throw new UsageError("sandbox start accepts either --vm or --gvisor, not both");
    if (vmSandbox && cpu !== undefined) throw new UsageError("VM sandboxes use a fixed CPU profile; --cpu selects the gVisor runtime");
    if (vmSandbox && !idempotencyKey) throw new UsageError("sandbox start --vm requires --idempotency-key; save and reuse it with the same options on retry");
    if (gvisor && size === "large") throw new UsageError("--size large is VM only; gVisor container sandboxes ignore --size small");
    let sandbox = await client.sandboxes.create(buildCreateSandboxRequest(id, {
      cpu,
      vmSandbox,
      gvisor: gvisor || cpu !== undefined,
      size,
      idempotencyKey,
      name,
    }));
    if (vmSandbox && sandbox.vmSandbox !== true) {
      throw new Error(`Server did not confirm VM selection for sandbox ${sandbox.id}; inspect and clean up that ID before retrying. Upgrade the server to one that supports VM creation.`);
    }
    if (sandbox.state === "pending" && !noWait) {
      write(io.stderr, `Sandbox ${sandbox.id} is pending; waiting up to ${SANDBOX_READY_TIMEOUT_MS / 1000} seconds for running...\n`);
      const outcome = await awaitRunning(client, sandbox.id, sleep, now);
      sandbox = outcome.sandbox;
      emit(io, json, { sandbox }, sandboxLine(sandbox));
      if (sandbox.state === "expired") {
        write(io.stderr, `Sandbox ${sandbox.id} expired before reaching running.\n`);
        return 1;
      }
      if (outcome.timedOut) {
        write(io.stderr, `Sandbox ${sandbox.id} is still ${sandbox.state}. Check later with 'bxc sandbox status ${sandbox.id}'.\n`);
        return 1;
      }
      return 0;
    }
    emit(io, json, { sandbox }, sandboxLine(sandbox));
    if (sandbox.state === "pending") write(io.stderr, "Creation receipt only. Save the sandbox ID; use sandbox status to confirm readiness. Reuse the same key and options on retry.\n");
    return 0;
  }
  if (action === "upload" || action === "download") {
    if (args.length !== 2) throw new UsageError(`sandbox ${action} requires SANDBOX_ID ${action === "upload" ? "LOCAL REMOTE" : "REMOTE LOCAL"}`);
    const [source, destination] = args;
    const bytes = action === "upload"
      ? await uploadFile(client, id, source, destination)
      : await downloadFile(client, id, source, destination);
    emit(io, json, { sandboxId: id, source, destination, bytes }, `${action === "upload" ? "Uploaded" : "Downloaded"} ${bytes} bytes: ${source} -> ${destination}\n`);
    return 0;
  }
  if (action === "status") {
    if (args.length) throw new UsageError("sandbox status takes one sandbox ID");
    const sandbox = await client.sandboxes.inspect(id);
    emit(io, json, { sandbox }, sandboxLine(sandbox));
    return 0;
  }
  if (action === "logs") {
    const filters = logFilters(args);
    if (args.length) throw new UsageError(`Unknown sandbox logs option: ${args[0]}`);
    return logsOutput(io, json, await client.sandboxes.logs(id, filters));
  }
  if (action === "costs") {
    if (args.length) throw new UsageError("sandbox costs takes one sandbox ID");
    return costDetailOutput(io, json, await client.sandboxes.costs(id));
  }
  if (action === "analytics") {
    const window = timeWindow(args);
    const resolutionSeconds = positive(option(args, "resolution"), "--resolution");
    if (resolutionSeconds !== undefined && (resolutionSeconds < 60 || resolutionSeconds > 86_400)) {
      throw new UsageError("--resolution must be from 60 to 86400 seconds");
    }
    const generation = positive(option(args, "generation"), "--generation");
    if (args.length) throw new UsageError(`Unknown sandbox analytics option: ${args[0]}`);
    return analyticsOutput(io, json, await client.sandboxes.analytics(id, { ...window, resolutionSeconds, generation }));
  }
  if (action === "preview") {
    const close = option(args, "close");
    const port = positive(option(args, "port"), "--port");
    if (args.length) throw new UsageError(`Unknown sandbox preview option: ${args[0]}`);
    if ((close === undefined) === (port === undefined)) {
      throw new UsageError("sandbox preview requires exactly one of --port PORT or --close PREVIEW_ID");
    }
    if (close !== undefined) {
      await client.previews.close(id, close);
      emit(io, json, { sandboxId: id, previewId: close, closed: true }, `Closed preview ${close} for ${id}.\n`);
      return 0;
    }
    if (port! > 65_535) throw new UsageError("--port must be an integer from 1 to 65535");
    return previewOutput(io, json, await client.previews.create(id, { port: port! }));
  }
  if (action === "expose") {
    if (json) throw new UsageError("sandbox expose is a foreground stream and does not support --json");
    const mappings = serviceMappings(args);
    if (args.length) throw new UsageError(`Unknown sandbox expose option: ${args[0]}`);
    const abort = new AbortController();
    const stop = () => abort.abort();
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const signal of signals) process.on(signal, stop);
    try {
      const handle = await expose(serviceAccessApi(connection, fetchImpl), id, mappings, abort.signal);
      for (const mapping of mappings) {
        write(io.stdout, `127.0.0.1:${mapping.local} -> ${id}:${mapping.remote}\n`);
      }
      write(io.stderr, `Service access expires at ${new Date(handle.expiresAt * 1_000).toISOString()}; press Ctrl+C to close it sooner.\n`);
      const cleanup = await handle.closed;
      if (cleanup === "untrusted-guest-report") {
        write(io.stderr, "Local forwarding is closed; VM revoke was reported by the guest and the fixed lease will still expire.\n");
      }
      return 0;
    } finally {
      abort.abort();
      for (const signal of signals) process.off(signal, stop);
    }
  }
  if (action === "ssh") {
    if (json) throw new UsageError("sandbox ssh carries raw bytes and does not support --json");
    if (env.BOXCOMPUTE_ENABLE_SSH !== "1") {
      throw new UsageError("sandbox ssh is experimental; set BOXCOMPUTE_ENABLE_SSH=1 to enable it");
    }
    const reconnect = flag(args, "reconnect");
    const revoke = option(args, "revoke");
    if (reconnect && revoke) throw new UsageError("--reconnect and --revoke cannot be combined");
    if (args.length) throw new UsageError(`Unknown sandbox ssh option: ${args[0]}`);
    return ssh(id, { reconnect, revoke }, cooperativeConnectionApi(connection, fetchImpl), env, streamIo);
  }
  if (action === "delete") {
    if (!flag(args, "yes") || args.length) throw new UsageError("sandbox delete requires SANDBOX_ID --yes");
    await client.sandboxes.delete(id);
    emit(io, json, { sandboxId: id, deleted: true }, `Destroyed sandbox runtime ${id}; its workspace remains.\n`);
    return 0;
  }
  if (action === "exec") {
    const separator = args.indexOf("--");
    if (separator < 0 || separator === args.length - 1) throw new UsageError("sandbox exec requires a program after --");
    const options = args.splice(0, separator);
    args.shift();
    const cwd = option(options, "cwd");
    const timeoutSeconds = positive(option(options, "timeout"), "--timeout");
    const maxOutputBytes = positive(option(options, "max-output-bytes"), "--max-output-bytes");
    const envInput = environment(options);
    if (options.length) throw new UsageError(`Unknown sandbox exec option: ${options[0]}`);
    const execution = await client.sandboxes.execute(id, {
      argv: args,
      cwd: cwd ?? "/workspace",
      timeoutSeconds: timeoutSeconds ?? 120,
      maxOutputBytes: maxOutputBytes ?? 262_144,
      ...(envInput ? { env: envInput } : {}),
    });
    return executionOutput(io, json, id, execution);
  }
  throw new UsageError(`Unknown sandbox action: ${action}`);
}

function harnessLine(harness: HarnessDetection): string {
  const status = harness.installed ? "installed" : "detected";
  return `  ${harness.label}\t${status}\t${harness.path}\n`;
}

function skillStatus(status: "installed" | "updated" | "unchanged"): string {
  if (status === "updated") return "Updated";
  if (status === "unchanged") return "Already installed";
  return "Installed";
}

function removalStatus(status: "removed" | "missing"): string {
  return status === "removed" ? "Removed" : "Not installed";
}

function helpFor(command?: string): string {
  if (command === "credits" || command === "billing") return billingHelp;
  if (command === "usage") return usageHelp;
  if (command === "sandbox") return sandboxHelp;
  if (command === "skill" || command === "skills") return skillHelp;
  if (command === "deleted") return deletedHelp;
  if (command === "costs") return costsHelp;
  if (command === "audit") return auditHelp;
  return rootHelp;
}

export function formatCliError(error: unknown): string {
  if (error instanceof BoxComputeError) return `${error.message} (HTTP ${error.status}${error.code ? ` ${error.code}` : ""})`;
  if (error instanceof BoxComputeTransportError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    write(process.stderr, `${error instanceof UsageError ? "Usage" : "Error"}: ${formatCliError(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    // npm exposes package binaries through a symlink. Comparing the raw argv
    // path with import.meta.url makes the installed CLI look like a library and
    // silently skips main(), so resolve both sides before comparing them.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) await main();
