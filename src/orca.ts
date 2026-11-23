import { BoxComputeError, type BoxCompute, type Sandbox } from "@boxcompute/sdk";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectionPaths, type Connection } from "./config.js";
import { resumeSandbox } from "./resume.js";
import { stopSandbox } from "./stop.js";

/**
 * Orca (orca.dev) per-workspace "Cloud VM" recipe steps. Orca runs them in the
 * user's repository with the ORCA_* variables set: `create` and `resume` print
 * one recipe-result JSON object on stdout, the others read Orca's lifecycle
 * payload on stdin. Everything else goes to stderr, because a stray line on
 * stdout is a broken result.
 *
 * The VM runs `orca-ide serve`; Orca's desktop reaches it through a BoxCompute
 * preview (wss://<id>.bxcpreview.site), so nothing is published on the VM's
 * own network. A preview lasts an hour unless kept open, and a WebSocket counts
 * as VM use only when it opens: `keep-open`, which the Orca plugin's worker
 * runs every 20 minutes while Orca is open, keeps both the link and the VM up.
 */

export const ORCA_PORT = 6768;
const REMOTE_BASE = "/workspace/.boxcompute/orca";
const PROJECTS = "/workspace/projects";
/** Used only when Orca does not say which version it is (ORCA_VERSION). */
const FALLBACK_ORCA_VERSION = "1.4.271";
const SIZES = ["small", "large", "xl", "xxl"] as const;
type Size = typeof SIZES[number];
const READY_TIMEOUT_MS = 180_000;

export type OrcaState = {
  instanceId: string;
  sandboxId: string;
  previewId?: string;
  suspended?: boolean;
  updatedAt: string;
};

export type OrcaDependencies = {
  client: BoxCompute;
  connection: Connection;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  readStdin: () => Promise<string>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  /** Runs a local program (git, gh) and returns its trimmed stdout, or null when it fails. */
  run: (file: string, args: string[], cwd: string) => Promise<string | null>;
};

export class OrcaUsageError extends Error {}

export async function runOrca(action: string | undefined, args: string[], deps: OrcaDependencies, json = false): Promise<number> {
  const at = args.indexOf("--size");
  let size: string | undefined;
  if (at >= 0) {
    if (action !== "create") throw new OrcaUsageError("--size applies only to orca create");
    size = args[at + 1];
    if (!size || size.startsWith("--")) throw new OrcaUsageError("--size requires small, large, xl or xxl");
    args.splice(at, 2);
  }
  if (args.length) throw new OrcaUsageError(`Unknown orca option: ${args[0]}`);
  if (action === "create") return create(deps, size);
  if (action === "resume") return resume(deps, await payload(deps));
  if (action === "suspend") return suspend(deps, await payload(deps));
  if (action === "destroy") return destroy(deps, await payload(deps));
  if (action === "keep-open") return keepOpen(deps, json);
  throw new OrcaUsageError("orca requires create, suspend, resume, destroy or keep-open");
}

// ─── Steps ──────────────────────────────────────────────────────────────────

async function create(deps: OrcaDependencies, sizeOption?: string): Promise<number> {
  const instanceId = requireInstanceId(deps.env.ORCA_VM_INSTANCE_ID);
  if ((deps.env.ORCA_RECIPE_RESULT_SCHEMA_VERSION ?? "1") !== "1") {
    throw new Error("BoxCompute VMs use Orca's own worktree checkout; recipes with checkoutMode provisioned-root are not supported.");
  }
  const repo = await localRepository(deps);
  // The environment wins, so a person can resize a recipe the plugin pins.
  const size = chooseSize(deps.env.BOXCOMPUTE_ORCA_SIZE || sizeOption);
  let state = await readState(deps.env, instanceId);
  let sandbox: Sandbox;
  if (state) {
    // A create Orca timed out or retried: carry on with the VM it already has.
    log(deps, `Reusing BoxCompute VM ${state.sandboxId} for this workspace…`);
    sandbox = await ensureRunning(deps, state.sandboxId);
  } else {
    const workspaceId = await chooseWorkspace(deps);
    log(deps, `Creating a ${size} BoxCompute VM…`);
    sandbox = await deps.client.sandboxes.create({
      workspaceId,
      vmSandbox: true,
      // The SDK's type predates xl and xxl; the server checks the account may use them.
      size: size as "small" | "large",
      name: sandboxName(deps.env.ORCA_WORKSPACE_NAME, instanceId),
      idempotencyKey: `orca-${instanceId}`,
    } as Parameters<BoxCompute["sandboxes"]["create"]>[0]);
    // Saved before the slow work, so destroy finds the VM even if Orca gives up on create.
    state = { instanceId, sandboxId: sandbox.id, updatedAt: new Date(deps.now()).toISOString() };
    await writeState(deps.env, state);
    sandbox = await waitRunning(deps, sandbox);
  }
  const result = await prepare(deps, state, repo);
  deps.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function resume(deps: OrcaDependencies, lifecycle: Lifecycle): Promise<number> {
  const state = await stateFor(deps, lifecycle);
  if (!state) throw new Error("No BoxCompute VM is recorded for this workspace; create a new workspace instead.");
  log(deps, `Starting BoxCompute VM ${state.sandboxId}…`);
  await ensureRunning(deps, state.sandboxId);
  const repo = await localRepository(deps).catch(() => null);
  const result = await prepare(deps, { ...state, suspended: false }, repo);
  deps.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function suspend(deps: OrcaDependencies, lifecycle: Lifecycle): Promise<number> {
  const state = await stateFor(deps, lifecycle);
  if (!state) throw new Error("No BoxCompute VM is recorded for this workspace.");
  // Marked first: keep-open must not touch a VM Orca put to sleep.
  await writeState(deps.env, { ...state, suspended: true, updatedAt: new Date(deps.now()).toISOString() });
  const { stopped } = await stopSandbox(deps.connection, deps.fetch, state.sandboxId);
  log(deps, stopped
    ? `Stopped BoxCompute VM ${state.sandboxId}; its files are kept.`
    : `BoxCompute VM ${state.sandboxId} was not running.`);
  return 0;
}

async function destroy(deps: OrcaDependencies, lifecycle: Lifecycle): Promise<number> {
  const instanceId = lifecycle.instanceId ?? deps.env.ORCA_VM_INSTANCE_ID;
  let sandboxId = (await stateFor(deps, lifecycle))?.sandboxId;
  if (!sandboxId && instanceId) {
    // Create never returned, and the state file is gone too: find the VM by the
    // name create gave it, which ends in this instance's id.
    const suffix = nameSuffix(requireInstanceId(instanceId));
    const matches = (await deps.client.sandboxes.list()).filter((item) => item.name.endsWith(suffix));
    if (matches.length > 1) throw new Error(`More than one BoxCompute VM is named for this workspace (${matches.map((item) => item.id).join(", ")}); delete the right one in BoxCompute.`);
    sandboxId = matches[0]?.id;
  }
  if (!sandboxId) {
    log(deps, "No BoxCompute VM was created for this workspace; nothing to delete.");
  } else {
    try {
      await deps.client.sandboxes.delete(sandboxId);
      log(deps, `Deleted BoxCompute VM ${sandboxId}.`);
    } catch (error) {
      if (!(error instanceof BoxComputeError && error.status === 404)) throw error;
      log(deps, `BoxCompute VM ${sandboxId} was already deleted.`);
    }
  }
  if (instanceId) await removeState(deps.env, requireInstanceId(instanceId));
  return 0;
}

/**
 * Keep each awake Orca VM's preview open another hour. Keeping it open counts
 * as VM use, which is what keeps a long agent run from the 30-minute idle stop:
 * Orca's single WebSocket is not counted after it opens.
 */
async function keepOpen(deps: OrcaDependencies, json: boolean): Promise<number> {
  const states = await listStates(deps.env);
  const results: { instanceId: string; sandboxId: string; status: "kept" | "closed" | "asleep" | "failed" }[] = [];
  for (const state of states) {
    if (state.suspended || !state.previewId) {
      results.push({ instanceId: state.instanceId, sandboxId: state.sandboxId, status: "asleep" });
      continue;
    }
    try {
      const kept = await keepPreviewOpen(deps, state.sandboxId, state.previewId);
      results.push({ instanceId: state.instanceId, sandboxId: state.sandboxId, status: kept ? "kept" : "closed" });
    } catch {
      results.push({ instanceId: state.instanceId, sandboxId: state.sandboxId, status: "failed" });
    }
  }
  const running = results.filter((item) => item.status === "kept").length;
  if (json) deps.stdout.write(`${JSON.stringify({ running, vms: results })}\n`);
  else deps.stdout.write(`${running} of ${results.length} Orca VM${results.length === 1 ? "" : "s"} kept open\n`);
  return results.some((item) => item.status === "failed") ? 1 : 0;
}

// ─── Preparing the VM ───────────────────────────────────────────────────────

type Repository = { url: string; name: string; token: string | null };

type RecipeResult = {
  schemaVersion: 1;
  pairingCode: string;
  projectRoot: string;
  userData: { provider: "boxcompute"; sandboxId: string; previewId: string };
};

async function prepare(deps: OrcaDependencies, state: OrcaState, repo: Repository | null): Promise<RecipeResult> {
  const { sandboxId, instanceId } = state;
  const version = orcaVersion(deps.env.ORCA_VERSION);
  const projectRoot = repo ? `${PROJECTS}/${repo.name}` : await existingProjectRoot(deps, sandboxId);
  await execute(deps, sandboxId, ["mkdir", "-p", REMOTE_BASE], 30);
  if (repo?.token) {
    // A file, not an argument or variable: execution arguments are kept in the VM's logs.
    await deps.client.files.write(sandboxId, `${REMOTE_BASE}/git-token`, new TextEncoder().encode(repo.token));
  }
  log(deps, "Installing Orca's server on the VM (first time only)…");
  // An operation, not one execute call: the first install takes minutes, and a
  // request held past 100 seconds is cut by BoxCompute's edge (HTTP 524).
  await operation(deps, sandboxId, ["bash", "-lc", SETUP_SCRIPT], 900, {
    BXC_ORCA_VERSION: version,
    BXC_ORCA_ROOT: projectRoot,
    BXC_ORCA_REPO_URL: repo?.url ?? "",
  });
  const preview = await deps.client.previews.create(sandboxId, { port: ORCA_PORT });
  const address = preview.url.replace(/^https:\/\//, "wss://");
  if (!address.startsWith("wss://")) throw new Error("BoxCompute returned a preview that is not HTTPS.");
  await writeState(deps.env, { ...state, previewId: preview.previewId, updatedAt: new Date(deps.now()).toISOString() });
  log(deps, "Starting Orca's server…");
  await execute(deps, sandboxId, ["bash", "-lc", SERVE_SCRIPT], 120, {
    BXC_ORCA_ROOT: projectRoot,
    BXC_ORCA_ADDRESS: address,
    BXC_ORCA_INSTANCE: instanceId,
  });
  // Read as a file rather than from the command's output, which the VM's logs keep:
  // the pairing code grants access to the server.
  const recipePath = `${REMOTE_BASE}/recipe.json`;
  const file = await deps.client.files.read(sandboxId, recipePath);
  await deps.client.files.remove(sandboxId, recipePath).catch(() => undefined);
  let served: { pairingCode?: unknown; projectRoot?: unknown };
  try {
    served = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.data)) as typeof served;
  } catch {
    throw new Error("Orca's server on the VM did not report how to connect.");
  }
  if (typeof served.pairingCode !== "string" || !served.pairingCode.startsWith("orca://pair?")) {
    throw new Error("Orca's server on the VM returned no pairing code.");
  }
  return {
    schemaVersion: 1,
    pairingCode: served.pairingCode,
    projectRoot: typeof served.projectRoot === "string" ? served.projectRoot : projectRoot,
    userData: { provider: "boxcompute", sandboxId, previewId: preview.previewId },
  };
}

/** The checkout a resumed VM already has, when this repository is not readable here. */
async function existingProjectRoot(deps: OrcaDependencies, sandboxId: string): Promise<string> {
  const listed = await execute(deps, sandboxId, ["bash", "-lc", `ls -1d ${PROJECTS}/*/.git 2>/dev/null | head -n 2`], 30);
  const roots = listed.stdout.split("\n").filter(Boolean).map((line) => line.replace(/\/\.git$/, ""));
  if (roots.length !== 1) throw new Error("Run this step from the workspace's repository.");
  return roots[0]!;
}

async function execute(
  deps: OrcaDependencies,
  sandboxId: string,
  argv: string[],
  timeoutSeconds: number,
  env?: Record<string, string>,
) {
  const result = await deps.client.sandboxes.execute(sandboxId, {
    argv, cwd: "/workspace", timeoutSeconds, maxOutputBytes: 65_536, ...(env ? { env } : {}),
  });
  if (result.exitCode !== 0 || result.timedOut) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-12).join("\n");
    throw new Error(`${detail || "A command on the VM failed."}\n(BoxCompute VM ${sandboxId}, exit ${result.timedOut ? "timeout" : result.exitCode})`);
  }
  return result;
}

/** A background command polled to its end, for work longer than one request may take. */
async function operation(
  deps: OrcaDependencies,
  sandboxId: string,
  argv: string[],
  timeoutSeconds: number,
  env: Record<string, string>,
): Promise<void> {
  let current = await deps.client.operations.start(sandboxId, {
    argv, cwd: "/workspace", env, timeoutSeconds, maxOutputBytes: 262_144, idempotencyKey: `orca-${randomUUID()}`,
  });
  const deadline = deps.now() + (timeoutSeconds + 120) * 1000;
  while (current.state === "accepted" || current.state === "running") {
    if (deps.now() >= deadline) throw new Error(`A command on BoxCompute VM ${sandboxId} did not finish in ${timeoutSeconds} seconds.`);
    current = await deps.client.operations.wait(sandboxId, current.operationId, { timeoutSeconds: 30 });
  }
  if (current.state === "completed" && current.exitCode === 0) return;
  let detail = "";
  try {
    const offset = Math.max(0, current.stderrOffset - 4096);
    const chunk = await deps.client.operations.output(sandboxId, current.operationId, { stream: "stderr", offset });
    detail = Buffer.from(chunk.dataBase64, "base64").toString("utf8").trim().split("\n").slice(-12).join("\n");
  } catch {
    // The state below still says what happened.
  }
  throw new Error(`${detail || "A command on the VM failed."}\n(BoxCompute VM ${sandboxId}, ${current.state}${current.exitCode === null ? "" : `, exit ${current.exitCode}`})`);
}

// The scripts take every value from the environment, never from their text, so
// nothing a repository or Orca names can change what they run.
export const SETUP_SCRIPT = String.raw`set -euo pipefail
B=/workspace/.boxcompute/orca
umask 077
mkdir -p "$B"
# A create Orca retried waits for the one still running instead of racing it.
exec 8>"$B/setup.lock"
flock 8
token="$B/git-token"
cleanup() { rm -f "$token" "$B/askpass"; }
trap cleanup EXIT
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "Unsupported CPU $(uname -m)" >&2; exit 1 ;; esac
dir="$B/server/$BXC_ORCA_VERSION"
if [ ! -x "$dir/bin/orca-ide" ]; then
  tmp="$(mktemp -d "$B/download.XXXXXX")"
  base="https://github.com/stablyai/orca/releases/download/v$BXC_ORCA_VERSION"
  archive="orca-server-linux-$arch.tar.gz"
  curl -fsSL --proto '=https' --retry 3 -o "$tmp/$archive" "$base/$archive"
  curl -fsSL --proto '=https' --retry 3 -o "$tmp/sums" "$base/orca-server-sha256sums.txt"
  expected="$(awk -v f="$archive" '$2 == f || $2 == "*" f { print $1 }' "$tmp/sums")"
  actual="$(sha256sum "$tmp/$archive" | awk '{ print $1 }')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "Orca server $BXC_ORCA_VERSION failed its checksum" >&2; rm -rf "$tmp"; exit 1; }
  mkdir -p "$tmp/x" && tar -xzf "$tmp/$archive" -C "$tmp/x" --strip-components=1
  rm -rf "$dir" && mkdir -p "$B/server" && mv "$tmp/x" "$dir" && rm -rf "$tmp"
fi
ln -sfn "$dir" "$B/server/current"
ln -sfn "$dir/bin/orca-ide" /usr/local/bin/orca-ide
# Claude Code and Codex from their vendors' installers, which check what they
# download; the serve step runs this in the background so Orca opens first.
cat > "$B/install-agents.sh" <<'AGENTS'
set -uo pipefail
B=/workspace/.boxcompute/orca
export HOME=/workspace PATH="/workspace/.local/bin:$PATH"
exec 9>"$B/agents.lock"
flock -n 9 || exit 0
claude() {
  [ -x "$HOME/.local/bin/claude" ] || { curl -fsSL --proto '=https' --tlsv1.2 https://claude.ai/install.sh -o "$B/claude-install.sh" && bash "$B/claude-install.sh" latest; }
  [ -x "$HOME/.local/bin/claude" ] && ln -sfn "$HOME/.local/bin/claude" /usr/local/bin/claude
}
codex() {
  [ -x "$HOME/.local/bin/codex" ] || { curl -fsSL --proto '=https' --tlsv1.2 https://chatgpt.com/codex/install.sh -o "$B/codex-install.sh" && CODEX_NON_INTERACTIVE=1 sh "$B/codex-install.sh" --release latest; }
  [ -x "$HOME/.local/bin/codex" ] && ln -sfn "$HOME/.local/bin/codex" /usr/local/bin/codex
}
claude > "$B/claude-install.log" 2>&1 &
codex > "$B/codex-install.log" 2>&1 &
wait
AGENTS
umask 022
if [ -n "$BXC_ORCA_REPO_URL" ]; then
  export GIT_TERMINAL_PROMPT=0
  if [ -s "$token" ]; then
    printf '%s\n' '#!/bin/sh' 'case "$1" in *sername*) echo x-access-token ;; *) cat /workspace/.boxcompute/orca/git-token ;; esac' > "$B/askpass"
    chmod 700 "$B/askpass"
    export GIT_ASKPASS="$B/askpass"
  fi
  if [ -d "$BXC_ORCA_ROOT/.git" ]; then
    git -C "$BXC_ORCA_ROOT" fetch --quiet --prune origin || echo "Could not fetch $BXC_ORCA_REPO_URL; using the VM's copy." >&2
  else
    mkdir -p "$(dirname "$BXC_ORCA_ROOT")"
    git clone --quiet -- "$BXC_ORCA_REPO_URL" "$BXC_ORCA_ROOT" || { echo "Could not clone $BXC_ORCA_REPO_URL. A private repository needs GH_TOKEN, GITHUB_TOKEN or 'gh auth login' on this computer." >&2; exit 1; }
  fi
fi
[ -d "$BXC_ORCA_ROOT/.git" ] || { echo "The VM has no checkout at $BXC_ORCA_ROOT." >&2; exit 1; }
`;

export const SERVE_SCRIPT = String.raw`set -euo pipefail
B=/workspace/.boxcompute/orca
O="$B/server/current/bin/orca-ide"
out="$B/recipe.json"
umask 077
rm -f "$out"
export HOME=/workspace ORCA_INSTANCE_ID="$BXC_ORCA_INSTANCE"
setsid nohup bash "$B/install-agents.sh" > /dev/null 2>&1 < /dev/null &
node="$(ls -d "$B"/server/current/runtimes/node-*/bin/node 2>/dev/null | head -n 1)"
[ -x "$node" ] || node="$(command -v node)"
ready() { "$O" status --json 2>/dev/null | "$node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).result?.runtime?.state==="ready"?0:1)}catch{process.exit(1)}})'; }
if ready; then
  # Still serving (the VM kept running while its link changed): pair with the new link.
  "$O" pair --address "$BXC_ORCA_ADDRESS" --json | "$node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;if(!r?.pairingUrl)process.exit(1);process.stdout.write(JSON.stringify({schemaVersion:1,pairingCode:r.pairingUrl,projectRoot:process.env.BXC_ORCA_ROOT}))})' > "$out"
  exit 0
fi
# The launcher prints the result and exits; the server it started keeps running.
setsid nohup "$O" serve --port 6768 --bind 127.0.0.1 --project-root "$BXC_ORCA_ROOT" --pairing-address "$BXC_ORCA_ADDRESS" --recipe-json > "$out" 2> "$B/serve.log" < /dev/null &
for _ in $(seq 1 120); do
  if "$node" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$out" 2>/dev/null; then exit 0; fi
  sleep 0.5
done
tail -n 20 "$B/serve.log" >&2
echo "Orca's server did not start within a minute." >&2
exit 1
`;

// ─── Local repository ───────────────────────────────────────────────────────

async function localRepository(deps: OrcaDependencies): Promise<Repository> {
  const cwd = deps.env.ORCA_REPO_PATH || process.cwd();
  let raw = await deps.run("git", ["remote", "get-url", "origin"], cwd);
  if (!raw) {
    const first = (await deps.run("git", ["remote"], cwd))?.split("\n").map((name) => name.trim()).find(Boolean);
    raw = first ? await deps.run("git", ["remote", "get-url", first], cwd) : null;
  }
  if (!raw) throw new Error("This repository has no Git remote. Push it to GitHub (or another Git host) so the BoxCompute VM can clone it.");
  const url = httpsRemote(raw);
  const host = new URL(url).hostname;
  const token = host === "github.com"
    ? deps.env.GH_TOKEN || deps.env.GITHUB_TOKEN || await deps.run("gh", ["auth", "token"], cwd)
    : null;
  return { url, name: repositoryName(url), token: token?.trim() || null };
}

/** The VM has no SSH key, so an SSH remote is cloned over HTTPS, without any credential in the URL. */
export function httpsRemote(remote: string): string {
  const value = remote.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(value);
  let url: URL;
  try {
    url = scp ? new URL(`https://${scp[1]}/${scp[2]}`) : new URL(value);
  } catch {
    throw new Error(`The VM cannot clone ${value}; use an HTTPS or SSH remote.`);
  }
  if (url.protocol === "ssh:" || url.protocol === "git:" || url.protocol === "http:") url = new URL(`https://${url.hostname}${url.pathname}`);
  if (url.protocol !== "https:") throw new Error(`The VM cannot clone a ${url.protocol} remote; use HTTPS or SSH.`);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

export function repositoryName(url: string): string {
  const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "repo";
  const name = last.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 64);
  return name || "repo";
}

// ─── BoxCompute ─────────────────────────────────────────────────────────────

function chooseSize(value: string | undefined): Size {
  if (!value) return "large";
  if (!SIZES.includes(value as Size)) throw new OrcaUsageError(`The VM size (--size or BOXCOMPUTE_ORCA_SIZE) must be one of ${SIZES.join(", ")}`);
  return value as Size;
}

async function chooseWorkspace(deps: OrcaDependencies): Promise<string> {
  const chosen = deps.env.BOXCOMPUTE_ORCA_WORKSPACE?.trim();
  if (chosen) return chosen;
  const workspaces = await deps.client.workspaces.list();
  if (!workspaces[0]) throw new Error("This BoxCompute account has no workspace yet; open app.boxcompute.ai once to create one.");
  return workspaces[0].id;
}

async function waitRunning(deps: OrcaDependencies, sandbox: Sandbox): Promise<Sandbox> {
  const deadline = deps.now() + READY_TIMEOUT_MS;
  let current = sandbox;
  while (current.state !== "running") {
    if (current.state === "expired") throw new Error(`BoxCompute VM ${current.id} ended before it started.`);
    if (deps.now() >= deadline) throw new Error(`BoxCompute VM ${current.id} is still ${current.state} after three minutes.`);
    await deps.sleep(3_000);
    current = await deps.client.sandboxes.inspect(current.id);
  }
  return current;
}

async function ensureRunning(deps: OrcaDependencies, sandboxId: string): Promise<Sandbox> {
  const current = await deps.client.sandboxes.inspect(sandboxId);
  if (current.state === "running") return current;
  return waitRunning(deps, await resumeSandbox(deps.connection, deps.fetch, sandboxId));
}

/** `POST /api/v2/sandboxes/{id}/previews/{previewId}/keep-open` (server 0.272.0+). False once the link has closed. */
async function keepPreviewOpen(deps: OrcaDependencies, sandboxId: string, previewId: string): Promise<boolean> {
  if (!/^sbx_[A-Za-z0-9_-]+$/.test(sandboxId) || !/^[a-f0-9]{32}$/.test(previewId)) return false;
  const response = await deps.fetch(
    new URL(`/api/v2/sandboxes/${sandboxId}/previews/${previewId}/keep-open`, deps.connection.url),
    {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${deps.connection.token}`, accept: "application/json" },
    },
  );
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return true;
}

// ─── Names and versions ─────────────────────────────────────────────────────

export function requireInstanceId(value: string | undefined): string {
  const id = value?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new OrcaUsageError("ORCA_VM_INSTANCE_ID is missing; run this from an Orca VM recipe.");
  }
  return id;
}

/** Ends with the instance id so destroy can find the VM without its state file. */
function nameSuffix(instanceId: string): string {
  return instanceId.startsWith("orca-") ? instanceId : `orca-${instanceId}`.slice(0, 48);
}

export function sandboxName(workspaceName: string | undefined, instanceId: string): string {
  const suffix = nameSuffix(instanceId);
  const label = (workspaceName ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, Math.max(0, 79 - suffix.length));
  return label ? `${label}-${suffix}` : suffix;
}

export function orcaVersion(value: string | undefined): string {
  const version = value?.trim().replace(/^v/, "") ?? "";
  // Match the desktop: Orca's client and server speak one protocol version.
  return /^\d+\.\d+\.\d+$/.test(version) ? version : FALLBACK_ORCA_VERSION;
}

// ─── Lifecycle payload and local state ──────────────────────────────────────

type Lifecycle = { instanceId?: string; sandboxId?: string };

async function payload(deps: OrcaDependencies): Promise<Lifecycle> {
  const text = (await deps.readStdin()).trim();
  let parsed: { instanceId?: unknown; recipeResult?: { userData?: { sandboxId?: unknown } } } = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error("Orca's lifecycle payload on stdin is not JSON.");
    }
  }
  const instanceId = typeof parsed.instanceId === "string" ? parsed.instanceId : deps.env.ORCA_VM_INSTANCE_ID;
  const sandboxId = parsed.recipeResult?.userData?.sandboxId;
  return {
    ...(instanceId ? { instanceId: requireInstanceId(instanceId) } : {}),
    ...(typeof sandboxId === "string" && /^sbx_[A-Za-z0-9_-]+$/.test(sandboxId) ? { sandboxId } : {}),
  };
}

async function stateFor(deps: OrcaDependencies, lifecycle: Lifecycle): Promise<OrcaState | null> {
  const saved = lifecycle.instanceId ? await readState(deps.env, lifecycle.instanceId) : null;
  if (saved) return saved;
  if (lifecycle.sandboxId && lifecycle.instanceId) {
    return { instanceId: lifecycle.instanceId, sandboxId: lifecycle.sandboxId, updatedAt: new Date(deps.now()).toISOString() };
  }
  return null;
}

function stateDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(connectionPaths(env).directory, "orca");
}

async function readState(env: NodeJS.ProcessEnv, instanceId: string): Promise<OrcaState | null> {
  try {
    const value = JSON.parse(await readFile(path.join(stateDirectory(env), `${instanceId}.json`), "utf8")) as Partial<OrcaState>;
    return typeof value.sandboxId === "string" && value.instanceId === instanceId ? value as OrcaState : null;
  } catch {
    return null;
  }
}

async function writeState(env: NodeJS.ProcessEnv, state: OrcaState): Promise<void> {
  const directory = stateDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = path.join(directory, `${state.instanceId}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

async function removeState(env: NodeJS.ProcessEnv, instanceId: string): Promise<void> {
  await rm(path.join(stateDirectory(env), `${instanceId}.json`), { force: true });
}

async function listStates(env: NodeJS.ProcessEnv): Promise<OrcaState[]> {
  let names: string[];
  try {
    names = await readdir(stateDirectory(env));
  } catch {
    return [];
  }
  const states = await Promise.all(names.filter((name) => name.endsWith(".json"))
    .map((name) => readState(env, name.slice(0, -5))));
  return states.filter((state): state is OrcaState => state !== null);
}

function log(deps: OrcaDependencies, message: string): void {
  deps.stderr.write(`${message}\n`);
}

/** Local git and gh, with no shell and a short deadline; failures are answers, not errors. */
export function runLocal(file: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: 10_000, maxBuffer: 65_536, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => resolve(error ? null : stdout.trim() || null));
  });
}
