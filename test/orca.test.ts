import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { BoxComputeError, type BoxCompute } from "@boxcompute/sdk";
import { runCli } from "../src/cli.js";
import {
  httpsRemote, orcaVersion, repositoryName, runOrca, sandboxName, SERVE_SCRIPT, SETUP_SCRIPT,
  type OrcaDependencies,
} from "../src/orca.js";

const connection = { url: "https://app.boxcompute.ai", token: "bc_live_test", tokenFile: "/unused" };
const instanceId = "orca-6f1c2d4e-0a1b-4c3d-9e8f-123456789abc";
const pairingCode = "orca://pair?code=secret-pairing";
const previewId = "c".repeat(32);
let configDir = "";

beforeEach(async () => { configDir = await mkdtemp(path.join(tmpdir(), "bxc-orca-")); });
afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

type Call = { method: string; args: unknown[] };

function fakeClient(overrides: { states?: string[]; list?: { id: string; name: string }[]; deleteStatus?: number; setupFails?: boolean } = {}) {
  const calls: Call[] = [];
  const states = [...(overrides.states ?? ["pending", "running"])];
  const files = new Map<string, Uint8Array>();
  const record = (method: string, ...args: unknown[]) => { calls.push({ method, args }); };
  const sandbox = (state: string) => ({ id: "sbx_orca", name: "n", state, workspaceId: "ws_one", vmSandbox: true, createdAt: 1, lastUsedAt: 1 });
  const client = {
    workspaces: { list: async () => { record("workspaces.list"); return [{ id: "ws_one", name: "Personal", createdAt: 1 }]; } },
    sandboxes: {
      create: async (input: unknown) => { record("sandboxes.create", input); return sandbox(states.shift() ?? "running"); },
      inspect: async (id: string) => { record("sandboxes.inspect", id); return sandbox(states.shift() ?? "running"); },
      list: async () => { record("sandboxes.list"); return overrides.list ?? []; },
      delete: async (id: string) => {
        record("sandboxes.delete", id);
        if (overrides.deleteStatus) throw new BoxComputeError({ status: overrides.deleteStatus, code: "NOT_FOUND", message: "gone" });
      },
      execute: async (id: string, input: { argv: string[]; env?: Record<string, string> }) => {
        record("sandboxes.execute", id, input);
        if (input.argv[2] === SERVE_SCRIPT) {
          files.set("/workspace/.boxcompute/orca/recipe.json", new TextEncoder().encode(JSON.stringify({
            schemaVersion: 1, pairingCode, projectRoot: input.env?.BXC_ORCA_ROOT,
          })));
        }
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false };
      },
    },
    operations: {
      start: async (id: string, input: { argv: string[]; env?: Record<string, string> }) => {
        record("operations.start", id, input);
        return { operationId: `op_${"a".repeat(32)}`, state: "running", exitCode: null, stderrOffset: 0 };
      },
      wait: async (id: string, operationId: string) => {
        record("operations.wait", id, operationId);
        return { operationId, state: overrides.setupFails ? "completed" : "completed", exitCode: overrides.setupFails ? 1 : 0, stderrOffset: 12 };
      },
      output: async (id: string, operationId: string, options: unknown) => {
        record("operations.output", id, operationId, options);
        return { stream: "stderr", dataBase64: Buffer.from("clone failed").toString("base64"), offset: 0, nextOffset: 12, earliestOffset: 0, truncated: false };
      },
    },
    previews: {
      create: async (id: string, input: unknown) => {
        record("previews.create", id, input);
        return { previewId, sandboxId: id, port: 6768, url: `https://${previewId}.bxcpreview.site`, expiresAt: "2026-11-23T04:00:00.000Z" };
      },
    },
    files: {
      write: async (id: string, file: string, data: Uint8Array) => { record("files.write", id, file); files.set(file, data); },
      read: async (id: string, file: string) => {
        record("files.read", id, file);
        const data = files.get(file);
        if (!data) throw new Error(`missing ${file}`);
        return { data, offset: 0, nextOffset: data.length, fileSize: data.length, eof: true };
      },
      remove: async (id: string, file: string) => { record("files.remove", id, file); files.delete(file); },
    },
  };
  return { client: client as unknown as BoxCompute, calls, files };
}

function deps(client: BoxCompute, options: {
  env?: NodeJS.ProcessEnv; stdin?: string; fetch?: typeof fetch;
  run?: OrcaDependencies["run"];
} = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => { out += chunk; });
  stderr.on("data", (chunk) => { err += chunk; });
  const value: OrcaDependencies = {
    client, connection,
    fetch: options.fetch ?? ((async () => { throw new Error("no fetch expected"); }) as unknown as typeof fetch),
    env: { BOXCOMPUTE_CONFIG_DIR: configDir, ORCA_VM_INSTANCE_ID: instanceId, ORCA_WORKSPACE_NAME: "fix login bug", ORCA_VERSION: "1.4.280", ...options.env },
    stdout, stderr,
    readStdin: async () => options.stdin ?? "",
    sleep: async () => undefined,
    now: () => Date.parse("2026-11-23T03:00:00Z"),
    run: options.run ?? (async (file, args) => {
      if (file === "git" && args.join(" ") === "remote get-url origin") return "git@github.com:acme/widget.git";
      if (file === "gh") return "gho_from_gh";
      return null;
    }),
  };
  return { value, out: () => out, err: () => err };
}

const state = async () => JSON.parse(await readFile(path.join(configDir, "orca", `${instanceId}.json`), "utf8"));

test("create makes one VM, keeps the token out of commands and prints only Orca's result", async () => {
  const { client, calls } = fakeClient();
  const d = deps(client);
  expect(await runOrca("create", [], d.value)).toBe(0);

  const created = calls.find((call) => call.method === "sandboxes.create")!.args[0] as Record<string, unknown>;
  expect(created).toEqual({
    workspaceId: "ws_one", vmSandbox: true, size: "large",
    name: `fix-login-bug-${instanceId}`, idempotencyKey: `orca-${instanceId}`,
  });
  // The token is written as a file, never into a command's arguments or environment.
  expect(calls.find((call) => call.method === "files.write")?.args[1]).toBe("/workspace/.boxcompute/orca/git-token");
  const executions = calls.filter((call) => call.method === "sandboxes.execute" || call.method === "operations.start")
    .map((call) => call.args[1] as { argv: string[]; env?: Record<string, string> });
  expect(JSON.stringify(executions)).not.toContain("gho_from_gh");
  // The long install runs as a polled operation, never one execute call.
  const setup = calls.find((call) => call.method === "operations.start")!.args[1] as { argv: string[]; env?: Record<string, string> };
  expect(setup.argv[2]).toBe(SETUP_SCRIPT);
  expect(setup.env).toEqual({ BXC_ORCA_VERSION: "1.4.280", BXC_ORCA_ROOT: "/workspace/projects/widget", BXC_ORCA_REPO_URL: "https://github.com/acme/widget.git" });
  const serve = executions.find((input) => input.argv[2] === SERVE_SCRIPT)!;
  expect(serve.env).toEqual({ BXC_ORCA_ROOT: "/workspace/projects/widget", BXC_ORCA_ADDRESS: `wss://${previewId}.bxcpreview.site`, BXC_ORCA_INSTANCE: instanceId });
  // The pairing code is read from a file and removed, not taken from command output.
  expect(calls.some((call) => call.method === "files.remove")).toBe(true);

  const lines = d.out().trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({
    schemaVersion: 1, pairingCode, projectRoot: "/workspace/projects/widget",
    userData: { provider: "boxcompute", sandboxId: "sbx_orca", previewId },
  });
  expect(d.err()).not.toContain("secret-pairing");
  expect(await state()).toMatchObject({ instanceId, sandboxId: "sbx_orca", previewId });
  expect((await stat(path.join(configDir, "orca", `${instanceId}.json`))).mode & 0o077).toBe(0);
});

test("--size picks the VM size, and the environment overrides it", async () => {
  const xl = fakeClient();
  await runOrca("create", ["--size", "xl"], deps(xl.client).value);
  expect((xl.calls.find((call) => call.method === "sandboxes.create")!.args[0] as { size: string }).size).toBe("xl");
  await rm(path.join(configDir, "orca"), { recursive: true, force: true });
  const small = fakeClient();
  await runOrca("create", ["--size", "xl"], deps(small.client, { env: { BOXCOMPUTE_ORCA_SIZE: "small" } }).value);
  expect((small.calls.find((call) => call.method === "sandboxes.create")!.args[0] as { size: string }).size).toBe("small");
});

test("a retried create reuses the VM it already made", async () => {
  const first = fakeClient();
  await runOrca("create", [], deps(first.client).value);
  const again = fakeClient({ states: ["running"] });
  expect(await runOrca("create", [], deps(again.client).value)).toBe(0);
  expect(again.calls.some((call) => call.method === "sandboxes.create")).toBe(false);
});

test("create refuses what it cannot run before creating anything", async () => {
  const { client, calls } = fakeClient();
  await expect(runOrca("create", [], deps(client, { env: { ORCA_RECIPE_RESULT_SCHEMA_VERSION: "2" } }).value)).rejects.toThrow("provisioned-root");
  await expect(runOrca("create", [], deps(client, { run: async () => null }).value)).rejects.toThrow("no Git remote");
  await expect(runOrca("create", [], deps(client, { env: { BOXCOMPUTE_ORCA_SIZE: "huge" } }).value)).rejects.toThrow("BOXCOMPUTE_ORCA_SIZE");
  await expect(runOrca("create", ["--size", "huge"], deps(client).value)).rejects.toThrow("must be one of");
  await expect(runOrca("resume", ["--size", "xl"], deps(client).value)).rejects.toThrow("only to orca create");
  await expect(runOrca("create", [], deps(client, { env: { ORCA_VM_INSTANCE_ID: "" } }).value)).rejects.toThrow("ORCA_VM_INSTANCE_ID");
  expect(calls.some((call) => call.method === "sandboxes.create")).toBe(false);
});

test("a failed install names the VM and the last lines it printed", async () => {
  const { client } = fakeClient({ setupFails: true });
  await expect(runOrca("create", [], deps(client).value)).rejects.toThrow(/clone failed\n\(BoxCompute VM sbx_orca, completed, exit 1\)/);
});

test("a public repository on another host clones without any token", async () => {
  const { client, calls } = fakeClient();
  const d = deps(client, { run: async (file, args) => file === "git" && args[0] === "remote" && args[1] === "get-url" ? "https://gitlab.com/acme/tool.git" : file === "gh" ? "gho_never" : null });
  await runOrca("create", [], d.value);
  expect(calls.some((call) => call.method === "files.write")).toBe(false);
});

test("suspend stops the VM and keep-open then leaves it alone", async () => {
  const { client } = fakeClient();
  await runOrca("create", [], deps(client).value);
  const stops: string[] = [];
  const fetcher = (async (url: unknown) => {
    stops.push(String(url));
    return new Response(JSON.stringify({ sandbox: { id: "sbx_orca", state: "cold", name: "n" }, stopped: true }));
  }) as typeof fetch;
  const lifecycle = JSON.stringify({ schemaVersion: 1, mode: "suspend", instanceId, recipeResult: { userData: { sandboxId: "sbx_orca" } } });
  expect(await runOrca("suspend", [], deps(client, { stdin: lifecycle, fetch: fetcher }).value)).toBe(0);
  expect(stops).toEqual(["https://app.boxcompute.ai/api/v2/sandboxes/sbx_orca/stop"]);
  expect(await state()).toMatchObject({ suspended: true });

  const keep = deps(client, { fetch: (async () => { throw new Error("must not touch a sleeping VM"); }) as unknown as typeof fetch });
  expect(await runOrca("keep-open", [], keep.value, true)).toBe(0);
  expect(JSON.parse(keep.out())).toEqual({ running: 0, vms: [{ instanceId, sandboxId: "sbx_orca", status: "asleep" }] });
});

test("resume starts the VM and prints a fresh result", async () => {
  const { client } = fakeClient();
  await runOrca("create", [], deps(client).value);
  const resumed = fakeClient({ states: ["cold", "running"] });
  const starts: string[] = [];
  const fetcher = (async (url: unknown) => {
    starts.push(String(url));
    return new Response(JSON.stringify({ sandbox: { id: "sbx_orca", state: "pending", name: "n" } }), { status: 201 });
  }) as typeof fetch;
  const d = deps(resumed.client, { stdin: JSON.stringify({ mode: "resume", instanceId }), fetch: fetcher });
  expect(await runOrca("resume", [], d.value)).toBe(0);
  expect(starts).toEqual(["https://app.boxcompute.ai/api/v2/sandboxes/sbx_orca/start"]);
  expect(JSON.parse(d.out()).pairingCode).toBe(pairingCode);
  expect(await state()).toMatchObject({ suspended: false, previewId });
});

test("keep-open keeps each awake VM's link and reports one that closed", async () => {
  const { client } = fakeClient();
  await runOrca("create", [], deps(client).value);
  const requests: { url: string; init?: RequestInit }[] = [];
  let status = 200;
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response("{}", { status });
  }) as typeof fetch;
  const kept = deps(client, { fetch: fetcher });
  expect(await runOrca("keep-open", [], kept.value, true)).toBe(0);
  expect(JSON.parse(kept.out())).toEqual({ running: 1, vms: [{ instanceId, sandboxId: "sbx_orca", status: "kept" }] });
  expect(requests[0]!.url).toBe(`https://app.boxcompute.ai/api/v2/sandboxes/sbx_orca/previews/${previewId}/keep-open`);
  expect(requests[0]!.init?.method).toBe("POST");
  expect(requests[0]!.init?.redirect).toBe("error");
  expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBe("Bearer bc_live_test");

  status = 404;
  const closed = deps(client, { fetch: fetcher });
  expect(await runOrca("keep-open", [], closed.value, true)).toBe(0);
  expect(JSON.parse(closed.out()).vms[0].status).toBe("closed");

  status = 500;
  expect(await runOrca("keep-open", [], deps(client, { fetch: fetcher }).value, true)).toBe(1);
});

test("destroy deletes the recorded VM, finds one by name, and is fine with none", async () => {
  const { client, calls } = fakeClient();
  await runOrca("create", [], deps(client).value);
  const destroy = (stdin: string, c = client) => runOrca("destroy", [], deps(c, { stdin }).value);
  expect(await destroy(JSON.stringify({ mode: "destroy", instanceId }))).toBe(0);
  expect(calls.filter((call) => call.method === "sandboxes.delete").map((call) => call.args[0])).toEqual(["sbx_orca"]);
  expect(await readdir(path.join(configDir, "orca"))).toEqual([]);

  // No state and no result: the VM named for this instance is the one deleted, and only it.
  const named = fakeClient({ list: [{ id: "sbx_other", name: "unrelated" }, { id: "sbx_named", name: `ws-${instanceId}` }] });
  expect(await destroy(JSON.stringify({ mode: "destroy", instanceId }), named.client)).toBe(0);
  expect(named.calls.filter((call) => call.method === "sandboxes.delete").map((call) => call.args[0])).toEqual(["sbx_named"]);

  const none = fakeClient({ list: [{ id: "sbx_other", name: "unrelated" }] });
  expect(await destroy(JSON.stringify({ mode: "destroy", instanceId }), none.client)).toBe(0);
  expect(none.calls.some((call) => call.method === "sandboxes.delete")).toBe(false);

  const gone = fakeClient({ deleteStatus: 404 });
  expect(await destroy(JSON.stringify({ mode: "destroy", instanceId, recipeResult: { userData: { sandboxId: "sbx_gone" } } }), gone.client)).toBe(0);
});

test("the server listens only on loopback and is restarted, never re-exposed, for a new link", () => {
  expect(SERVE_SCRIPT).toContain("--bind 127.0.0.1");
  // orca-ide pair re-exposes a loopback server to the network and refuses.
  expect(SERVE_SCRIPT).not.toMatch(/"\$O" pair/);
  expect(SETUP_SCRIPT).toContain("sha256sum");
});

test("remotes, names and versions", () => {
  expect(httpsRemote("git@github.com:acme/widget.git")).toBe("https://github.com/acme/widget.git");
  expect(httpsRemote("ssh://git@github.com/acme/widget.git")).toBe("https://github.com/acme/widget.git");
  expect(httpsRemote("https://user:token@github.com/acme/widget.git")).toBe("https://github.com/acme/widget.git");
  expect(() => httpsRemote("/srv/git/widget")).toThrow();
  expect(repositoryName("https://github.com/acme/my%20repo.git")).toBe("my-20repo");
  expect(repositoryName("https://github.com/acme/.hidden.git")).toBe("hidden");
  const long = sandboxName("x".repeat(200), instanceId);
  expect(long.length).toBeLessThanOrEqual(80);
  expect(long.endsWith(instanceId)).toBe(true);
  expect(sandboxName(undefined, instanceId)).toBe(instanceId);
  expect(orcaVersion("1.4.300")).toBe("1.4.300");
  expect(orcaVersion("v1.4.300")).toBe("1.4.300");
  expect(orcaVersion("1.4.300; rm -rf /")).toBe("1.4.271");
});

test("bxc orca prints its help and refuses unknown steps", async () => {
  const io = { stdout: new PassThrough(), stderr: new PassThrough() };
  let out = "";
  io.stdout.on("data", (chunk) => { out += chunk; });
  expect(await runCli(["orca"], { io, env: {}, syncManagedSkills: async () => [] })).toBe(0);
  expect(out).toContain("BOXCOMPUTE_ORCA_SIZE");
  await expect(runCli(["orca", "explode"], { io, env: {}, syncManagedSkills: async () => [], loadConnection: async () => connection }))
    .rejects.toThrow("orca requires");
});
