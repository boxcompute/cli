import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { BoxComputeError } from "@boxcompute/sdk";
import { formatCliError, runCli } from "../src/cli.js";
import { stopSandbox } from "../src/stop.js";

const connection = { url: "https://app.boxcompute.ai", token: "test-credential", tokenFile: "/unused" };
const sandbox = { id: "sbx_running", state: "cold", name: "retained", workspaceId: "ws_one", vmSandbox: true, createdAt: 1, lastUsedAt: 2 } as const;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("stop calls only the stop endpoint with an empty JSON body", async () => {
  let calls = 0;
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    calls++;
    expect(String(url)).toBe("https://app.boxcompute.ai/api/v2/sandboxes/sbx_running/stop");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-credential");
    return response({ sandbox, stopped: true });
  }) as typeof fetch;
  expect(await stopSandbox(connection, fetcher, sandbox.id)).toEqual({ sandbox, stopped: true });
  expect(calls).toBe(1);
});

test("stop rejects unsafe origins and IDs before sending credentials", async () => {
  const fetcher = (async () => { throw new Error("must not send"); }) as unknown as typeof fetch;
  for (const url of ["http://public.example", "https://user:pass@app.boxcompute.ai", "https://app.boxcompute.ai/other", "https://app.boxcompute.ai/?query=yes"]) {
    await expect(stopSandbox({ ...connection, url }, fetcher, sandbox.id)).rejects.toThrow("Stop requires");
  }
  await expect(stopSandbox(connection, fetcher, "../sbx_other")).rejects.toThrow("sandbox ID");
});

test("busy, rejected, unsupported and unreachable stops say what to do", async () => {
  const run = (handler: () => Response) => stopSandbox(connection, (async () => handler()) as unknown as typeof fetch, sandbox.id);

  const busy = await run(() => response({ code: "SANDBOX_UNAVAILABLE", error: "This VM is pending, so it cannot be stopped now." }, 409)).catch((error) => error);
  expect(busy).toBeInstanceOf(BoxComputeError);
  expect(formatCliError(busy)).toBe("Sandbox sbx_running is still starting, stopping or in use; run 'bxc sandbox stop sbx_running' again in a moment (HTTP 409 SANDBOX_UNAVAILABLE)");

  const container = await run(() => response({ code: "INVALID_REQUEST", error: "Only VMs can be stopped. Legacy containers stop when idle." }, 400)).catch((error) => error);
  expect(formatCliError(container)).toBe("Only VMs can be stopped. Legacy containers stop when idle. (HTTP 400 INVALID_REQUEST)");

  await expect(run(() => new Response("404 Not Found", { status: 404 }))).rejects.toThrow("does not support stopping");
  await expect(stopSandbox(connection, (async () => { throw new Error("private transport content"); }) as unknown as typeof fetch, sandbox.id))
    .rejects.toThrow("Stop request did not reach BoxCompute");
  for (const body of [{ sandbox: { ...sandbox, id: "sbx_other" }, stopped: true }, { sandbox }, { sandbox: { ...sandbox, state: "unknown" }, stopped: true }]) {
    await expect(run(() => response(body))).rejects.toThrow("Stop was not confirmed");
  }
  await expect(run(() => new Response("x".repeat(65_537)))).rejects.toThrow("Stop was not confirmed");
});

test("CLI reports a stop, a VM that was not running, and refuses options", async () => {
  for (const stopped of [true, false]) {
    for (const json of [true, false]) {
      const io = { stdout: new PassThrough(), stderr: new PassThrough() };
      const calls: string[] = [];
      const deps = { io, env: {}, loadConnection: async () => connection, syncManagedSkills: async () => [],
        fetch: (async (url: unknown) => { calls.push(String(url)); return response({ sandbox, stopped }); }) as unknown as typeof fetch };
      expect(await runCli([...(json ? ["--json"] : []), "sandbox", "stop", sandbox.id], deps)).toBe(0);
      expect(calls).toEqual([`https://app.boxcompute.ai/api/v2/sandboxes/${sandbox.id}/stop`]);
      const out = io.stdout.read().toString();
      if (json) expect(JSON.parse(out)).toEqual({ sandbox, stopped });
      else expect(out).toBe(stopped
        ? "Stopped sandbox sbx_running; its files are kept. Start it again with 'bxc sandbox resume sbx_running'.\n"
        : "Sandbox sbx_running was not running (cold); nothing to stop.\n");
    }
  }
  const io = { stdout: new PassThrough(), stderr: new PassThrough() };
  await expect(runCli(["sandbox", "stop", sandbox.id, "--force"], { io, env: {}, loadConnection: async () => connection,
    syncManagedSkills: async () => [], fetch: (async () => { throw new Error("must not send"); }) as unknown as typeof fetch }))
    .rejects.toThrow("Unknown sandbox stop option: --force");
});
