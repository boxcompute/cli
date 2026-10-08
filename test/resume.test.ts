import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { resumeSandbox } from "../src/resume.js";
import { runCli } from "../src/cli.js";

const connection = { url: "https://app.boxcompute.ai", token: "test-credential", tokenFile: "/unused" };
const sandbox = { id: "sbx_existing", state: "pending", name: "retained", workspaceId: "ws_one", vmSandbox: true, createdAt: 1, lastUsedAt: null } as const;
const response = (value: unknown, status = 201) => new Response(JSON.stringify(value), { status });

test("resume calls only the existing sandbox start endpoint and retains identity", async () => {
  let calls = 0;
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    calls++;
    expect(String(url)).toBe("https://app.boxcompute.ai/api/v2/sandboxes/sbx_existing/start");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("saved-resume");
    return response({ sandbox });
  }) as typeof fetch;
  expect(await resumeSandbox(connection, fetcher, sandbox.id, "saved-resume")).toEqual(sandbox);
  expect(calls).toBe(1);
});

test("resume rejects unsafe origins, IDs and keys before sending credentials", async () => {
  const fetcher = (async () => { throw new Error("must not send"); }) as unknown as typeof fetch;
  for (const url of ["http://public.example", "https://user:pass@app.boxcompute.ai", "https://app.boxcompute.ai/other", "https://app.boxcompute.ai/?query=yes"]) {
    await expect(resumeSandbox({ ...connection, url }, fetcher, sandbox.id)).rejects.toThrow("Resume requires");
  }
  await expect(resumeSandbox(connection, fetcher, "../sbx_other")).rejects.toThrow("sandbox ID");
  await expect(resumeSandbox(connection, fetcher, sandbox.id, "invalid key")).rejects.toThrow("idempotency");
});

test("uncertain, unauthorized and malformed responses never retry or expose response content", async () => {
  const cases = [
    () => response({ error: "private server content" }, 403),
    () => response({ sandbox: { ...sandbox, id: "sbx_other" } }),
    () => response({ sandbox: { ...sandbox, state: "unknown" } }),
    () => new Response("x".repeat(65_537)),
    () => { throw new Error("private transport content"); },
  ];
  for (const handler of cases) {
    let calls = 0;
    const fetcher = (async () => { calls++; return handler(); }) as unknown as typeof fetch;
    await expect(resumeSandbox(connection, fetcher, sandbox.id)).rejects.toThrow("Resume was not confirmed");
    expect(calls).toBe(1);
  }
});

test("CLI waits for the same pending VM and reports readiness", async () => {
  const io = { stdout: new PassThrough(), stderr: new PassThrough() };
  const calls: string[] = [];
  const deps = { io, env: {}, loadConnection: async () => connection, syncManagedSkills: async () => [], sleep: async () => {},
    fetch: (async (url: unknown, init?: RequestInit) => {
      calls.push(String(url));
      return response({ sandbox: { ...sandbox, state: init?.method === "POST" ? "pending" : "running" } });
    }) as typeof fetch };
  expect(await runCli(["--json", "sandbox", "resume", sandbox.id], deps)).toBe(0);
  expect(calls).toEqual([`https://app.boxcompute.ai/api/v2/sandboxes/${sandbox.id}/start`, `https://app.boxcompute.ai/api/v2/sandboxes/${sandbox.id}`]);
  expect(JSON.parse(io.stdout.read().toString()).sandbox.state).toBe("running");
});

test("CLI no-wait returns the pending receipt; expired resume is a failure", async () => {
  for (const state of ["pending", "expired"]) {
    const io = { stdout: new PassThrough(), stderr: new PassThrough() };
    let calls = 0;
    const deps = { io, env: {}, loadConnection: async () => connection, syncManagedSkills: async () => [],
      fetch: (async () => { calls++; return response({ sandbox: { ...sandbox, state } }); }) as unknown as typeof fetch };
    expect(await runCli(["--json", "sandbox", "resume", sandbox.id, "--no-wait"], deps)).toBe(state === "pending" ? 0 : 1);
    expect(calls).toBe(1);
    expect(JSON.parse(io.stdout.read().toString()).sandbox.state).toBe(state);
  }
});
