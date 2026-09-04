#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { hostname, platform } from "node:os";
import { fileURLToPath } from "node:url";
import {
  BoxComputeClient,
  BoxComputeHttpError,
  publicRequest,
  type Execution,
  type Sandbox,
} from "./client.js";
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
  type AgentTarget,
  type HarnessDetection,
} from "./skill.js";

const DEFAULT_URL = "https://app.boxcompute.ai";
const CLI_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const rootHelp = `BoxCompute CLI

Usage: bxc [options] [command]

Commands:

  version                         Print the version number and exit
  login                           Log in through BoxCompute in your browser
  logout                          Revoke and remove the saved CLI credential
  auth                            [alias: login] Authentication commands
    logout                        Revoke and remove the saved CLI credential
  doctor                          Verify the saved connection
  sandboxes                       [aliases: list, ls] List workspaces and sandbox state
  sandbox                         Manage isolated BoxCompute sandboxes
    start                         Start or resume a workspace sandbox
    status                        Inspect one sandbox
    exec                          Execute a program inside a sandbox
    delete                        [alias: rm] Destroy the runtime; the workspace remains
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
  $ bxc skill detect
  $ bxc skill install
  $ bxc sandbox exec WORKSPACE_ID -- python -m pytest

Compatibility:

  The previous bcompute command remains available as an alias.
`;

const sandboxHelp = `Manage isolated BoxCompute sandboxes

Usage: bxc sandbox <command> [options]

Commands:

  start WORKSPACE_ID              Start or resume a workspace sandbox
  status SANDBOX_ID               Inspect one sandbox
  exec SANDBOX_ID [options] -- PROGRAM [ARG...]
                                  Execute a program inside a sandbox
  delete SANDBOX_ID --yes         [alias: rm] Destroy the runtime; keep the workspace

Exec options:

  --cwd PATH                      Working directory under /workspace
  --env KEY=VALUE                 Set an environment variable; repeatable
  --timeout SECONDS               Command timeout
  --max-output-bytes BYTES        Maximum captured output
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

type Io = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
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
  loadConnection?: (env: NodeJS.ProcessEnv) => Promise<Connection>;
  loadSavedUrl?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  saveConnection?: (url: string, token: string, env: NodeJS.ProcessEnv) => Promise<void>;
  clearConnection?: (env: NodeJS.ProcessEnv) => Promise<void>;
  detectHarnesses?: typeof detectHarnesses;
  installSkill?: typeof installSkill;
  removeSkill?: typeof removeSkill;
  readSkill?: typeof readSkill;
};

class UsageError extends Error {
  constructor(message: string) { super(message); this.name = "UsageError"; }
}

function browser(url: string): void {
  const system = platform();
  const command = system === "darwin" ? "open" : system === "win32" ? "cmd" : "xdg-open";
  const args = system === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
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

function anyFlag(tokens: string[], ...names: string[]): boolean {
  const index = tokens.findIndex((token) => names.includes(token));
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

async function authenticate(args: string[], dependencies: Required<Pick<CliDependencies,
  "fetch" | "now" | "sleep" | "openBrowser" | "loadSavedUrl" | "saveConnection"
>> & { env: NodeJS.ProcessEnv; io: Io; json: boolean }): Promise<number> {
  const url = option(args, "url") ?? await dependencies.loadSavedUrl(dependencies.env) ?? DEFAULT_URL;
  const noOpen = flag(args, "no-open");
  if (args.length) throw new UsageError(`Unexpected auth argument: ${args[0]}`);
  let started: DeviceAuthorization;
  try {
    started = await publicRequest<DeviceAuthorization>(url, "/api/cli-auth/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: `${hostname()} (${platform()})` }),
    }, dependencies.fetch);
  } catch (error) {
    if (error instanceof BoxComputeHttpError && [401, 404, 405].includes(error.status)) {
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
      const result = await publicRequest<{ token: string }>(url, "/api/cli-auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: started.deviceCode }),
      }, dependencies.fetch);
      await dependencies.saveConnection(url, result.token, dependencies.env);
      emit(dependencies.io, dependencies.json, { authenticated: true, url }, `Authenticated with ${url}.\nNext: bxc skill install\n`);
      return 0;
    } catch (error) {
      if (error instanceof BoxComputeHttpError && error.status === 428 && error.message === "authorization_pending") continue;
      if (error instanceof BoxComputeHttpError && error.status === 410) throw new Error("Browser authentication expired. Run `bxc auth` again.");
      throw error;
    }
  }
  throw new Error("Browser authentication expired. Run `bxc auth` again.");
}

function sandboxLine(sandbox: Sandbox): string {
  return `${sandbox.id}\t${sandbox.state}\t${sandbox.name}\n`;
}

function executionOutput(io: Io, json: boolean, sandboxId: string, result: Execution): number {
  if (json) emit(io, true, { sandboxId, ...result }, "");
  else {
    write(io.stdout, result.stdout);
    write(io.stderr, result.stderr);
    write(io.stderr, `sandbox=${sandboxId} exitCode=${result.exitCode ?? "null"} timedOut=${result.timedOut}\n`);
  }
  return result.exitCode ?? 1;
}

export async function runCli(argv: string[], supplied: CliDependencies = {}): Promise<number> {
  const env = supplied.env ?? process.env;
  const io = supplied.io ?? { stdout: process.stdout, stderr: process.stderr };
  const fetchImpl = supplied.fetch ?? fetch;
  const now = supplied.now ?? Date.now;
  const sleep = supplied.sleep ?? delay;
  const openBrowser = supplied.openBrowser ?? browser;
  const load = supplied.loadConnection ?? loadConnection;
  const savedUrl = supplied.loadSavedUrl ?? loadSavedUrl;
  const save = supplied.saveConnection ?? saveConnection;
  const clear = supplied.clearConnection ?? clearConnection;
  const detect = supplied.detectHarnesses ?? detectHarnesses;
  const install = supplied.installSkill ?? installSkill;
  const remove = supplied.removeSkill ?? removeSkill;
  const skillText = supplied.readSkill ?? readSkill;
  const args = [...argv];
  const json = flag(args, "json");
  const versionRequested = args[0] === "version" || anyFlag(args, "--version", "-V", "-v");
  if (versionRequested) {
    emit(io, json, { version: CLI_VERSION }, `${CLI_VERSION}\n`);
    return 0;
  }
  const helpRequested = anyFlag(args, "--help", "-h");
  if (!args.length || args[0] === "help" || helpRequested) {
    const helpTarget = args[0] === "help" ? args[1] : args[0];
    write(io.stdout, helpFor(helpTarget));
    return 0;
  }

  let command = args.shift();
  if (command === "login") command = "auth";
  if (command === "skills") command = "skill";
  if (command === "list" || command === "ls") command = "sandboxes";

  if (command === "logout") {
    if (args.length) throw new UsageError("logout takes no options");
    const connection = await load(env);
    await new BoxComputeClient(connection, fetchImpl).logout();
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
      await new BoxComputeClient(connection, fetchImpl).logout();
      await clear(env);
      emit(io, json, { authenticated: false }, "BoxCompute CLI credential revoked and removed.\n");
      return 0;
    }
    return authenticate(args, { env, io, json, fetch: fetchImpl, now, sleep, openBrowser, loadSavedUrl: savedUrl, saveConnection: save });
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

  const connection = await load(env);
  const client = new BoxComputeClient(connection, fetchImpl);
  if (command === "doctor") {
    const sandboxes = await client.list();
    emit(io, json, { connected: true, url: connection.url, sandboxes: sandboxes.length }, `Connected to ${connection.url} · ${sandboxes.length} workspace${sandboxes.length === 1 ? "" : "s"}\n`);
    return 0;
  }
  if (command === "sandboxes") {
    if (args.length) throw new UsageError("sandboxes takes no options");
    const sandboxes = await client.list();
    emit(io, json, { sandboxes }, sandboxes.length ? sandboxes.map(sandboxLine).join("") : "No workspaces found. Create one in BoxCompute first.\n");
    return 0;
  }
  if (command !== "sandbox") throw new UsageError(`Unknown command: ${command}`);

  let action = args.shift();
  if (action === "rm") action = "delete";
  const id = args.shift();
  if (!action || !id) throw new UsageError("sandbox requires an action and sandbox ID");
  if (action === "start") {
    if (args.length) throw new UsageError("sandbox start takes one workspace ID");
    const sandbox = await client.start(id);
    emit(io, json, { sandbox }, sandboxLine(sandbox));
    return 0;
  }
  if (action === "status") {
    if (args.length) throw new UsageError("sandbox status takes one sandbox ID");
    const sandbox = await client.inspect(id);
    emit(io, json, { sandbox }, sandboxLine(sandbox));
    return 0;
  }
  if (action === "delete") {
    if (!flag(args, "yes") || args.length) throw new UsageError("sandbox delete requires SANDBOX_ID --yes");
    await client.delete(id);
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
    return executionOutput(io, json, id, await client.execute(id, { argv: args, cwd, timeoutSeconds, maxOutputBytes, env: envInput }));
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
  if (command === "sandbox") return sandboxHelp;
  if (command === "skill" || command === "skills") return skillHelp;
  return rootHelp;
}

export function formatCliError(error: unknown): string {
  if (error instanceof BoxComputeHttpError) return `${error.message} (HTTP ${error.status})`;
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
