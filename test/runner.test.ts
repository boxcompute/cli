import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ServerWebSocket } from "bun";
import { runCli } from "../src/cli.js";
import {
  parseDuration,
  parseRequest,
  runRunner,
  runnerSocketUrl,
  safeText,
  type RunnerDependencies,
  type RunnerOptions,
} from "../src/runner.js";

const TOKEN = "bxr_test_0123456789abcdef_SECRET";
const SANDBOX = "bxs-0123456789abcdef";
const DISPATCH = fileURLToPath(new URL("./fixtures/fake-dispatch.sh", import.meta.url));

type Frame = Record<string, unknown>;
type PeerData = { peer: Peer | null; path: string; authorization: string | null };

class Peer {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(private readonly socket: ServerWebSocket<PeerData>, readonly path: string, readonly authorization: string | null) {}
  send(frame: Frame): void {
    this.socket.send(JSON.stringify(frame));
  }
  close(code: number, reason: string): void {
    this.socket.close(code, reason);
  }
  next(match: (frame: Frame) => boolean): Promise<Frame> {
    return until(() => this.frames.find(match));
  }
  result(id: string): Promise<Frame> {
    return this.next((frame) => frame.type === "result" && frame.id === id);
  }
  results(id: string): Frame[] {
    return this.frames.filter((frame) => frame.type === "result" && frame.id === id);
  }
  output(id: string, stream: "stdout" | "stderr"): string {
    return Buffer.concat(this.frames
      .filter((frame) => frame.type === "output" && frame.id === id && frame.stream === stream)
      .map((frame) => Buffer.from(frame.data as string, "base64"))).toString("utf8");
  }
  request(id: string, fields: Frame): void {
    this.send({ type: "request", id, ...fields });
  }
}

class Captured {
  readonly stream = new PassThrough();
  text = "";
  constructor() {
    this.stream.on("data", (chunk: Buffer) => { this.text += chunk.toString("utf8"); });
  }
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type Probe<T> = () => T | undefined | null | false | Promise<T | undefined | null | false>;

async function until<T>(probe: Probe<T>, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the runner");
    await sleep(10);
  }
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeServer() {
  const peers: Peer[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      const data: PeerData = { peer: null, path: `${url.pathname}${url.search}`, authorization: request.headers.get("authorization") };
      return server.upgrade(request, { data }) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      data: {} as PeerData,
      open(ws) {
        const peer = new Peer(ws, ws.data.path, ws.data.authorization);
        ws.data.peer = peer;
        peers.push(peer);
      },
      message(ws, message) {
        ws.data.peer?.frames.push(JSON.parse(String(message)) as Frame);
      },
      close(ws, code, reason) {
        if (ws.data.peer) ws.data.peer.closed = { code, reason };
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return { peers, url: `http://127.0.0.1:${server.port}` };
}

async function startRunner(url: string, options: Partial<RunnerOptions> = {}, dependencies: Partial<RunnerDependencies> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "bxc-runner-"));
  const log = path.join(directory, "dispatch.log");
  const stdout = new Captured();
  const stderr = new Captured();
  const abort = new AbortController();
  const done = runRunner({
    url,
    token: TOKEN,
    image: "node:22-bookworm",
    imageChosen: false,
    dispatch: DISPATCH,
    idleStopMs: 0,
    verbose: false,
    version: "0.12.0-test",
    ...options,
  }, {
    env: { PATH: process.env.PATH, BOXCOMPUTE_RUNNER_TOKEN: TOKEN, FAKE_DISPATCH_LOG: log },
    stdout: stdout.stream,
    stderr: stderr.stream,
    signal: abort.signal,
    WebSocket,
    random: () => 0,
    ...dependencies,
  });
  cleanups.push(async () => {
    abort.abort();
    await done.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    done,
    abort,
    stdout,
    stderr,
    dispatchLog: () => readFile(log, "utf8").catch(() => ""),
  };
}

async function welcomed(url: string, options: Partial<RunnerOptions> = {}, dependencies: Partial<RunnerDependencies> = {}, maxConcurrent = 8) {
  const { peers } = servers.get(url)!;
  const runner = await startRunner(url, options, dependencies);
  const peer = await until(() => peers[0]);
  await peer.next((frame) => frame.type === "hello");
  peer.send({ type: "welcome", runnerId: "rnr_test", name: "Test runner", maxConcurrent });
  await until(() => runner.stdout.text.includes("Connected as"));
  return { runner, peer, peers };
}

const servers = new Map<string, ReturnType<typeof fakeServer>>();
function listen() {
  const instance = fakeServer();
  servers.set(instance.url, instance);
  cleanups.push(() => servers.delete(instance.url));
  return instance.url;
}

describe("bxc runner protocol", () => {
  it("speaks protocol v1 through a dispatch program and keeps the token out of children and logs", async () => {
    const url = listen();
    const { peers } = servers.get(url)!;
    const runner = await startRunner(url);
    const peer = await until(() => peers[0]);
    const hello = await peer.next((frame) => frame.type === "hello");
    expect(peer.path).toBe("/api/runners/connect");
    expect(peer.authorization).toBeNull();
    expect(hello).toEqual({
      type: "hello",
      protocol: 1,
      token: TOKEN,
      client: { name: "bxc", version: "0.12.0-test", platform: process.platform, arch: process.arch, dispatch: "custom", image: null },
    });

    peer.request("early", { op: "ensure", sandbox: SANDBOX });
    expect(await peer.result("early")).toEqual({ type: "result", id: "early", ok: false, error: "runner is not ready" });

    peer.send({ type: "welcome", runnerId: "rnr_test", name: "Laptop\u0007 runner", maxConcurrent: 8 });
    await until(() => runner.stdout.text.includes("Connected as"));
    expect(runner.stdout.text).toContain(
      'Connected as "Laptop runner". Chats that run on this runner will run commands through fake-dispatch.sh. Press Ctrl-C to stop.\n',
    );

    peer.send({ type: "ping", t: 42 });
    expect(await peer.next((frame) => frame.type === "pong")).toEqual({ type: "pong", t: 42 });
    peer.send({ type: "telemetry", id: "ignored", anything: true });

    peer.request("e1", { op: "ensure", sandbox: SANDBOX });
    expect(await peer.result("e1")).toEqual({ type: "result", id: "e1", ok: true });

    peer.request("x1", { op: "exec", sandbox: SANDBOX, argv: ["sh", "-c", "printf hello; printf oops >&2; exit 3"] });
    expect(await peer.result("x1")).toEqual({ type: "result", id: "x1", ok: true, exitCode: 3 });
    expect(peer.output("x1", "stdout")).toBe("hello");
    expect(peer.output("x1", "stderr")).toBe("oops");
    // Every output frame precedes its result.
    const positions = (type: string) => peer.frames.flatMap((frame, index) => (frame.type === type && frame.id === "x1" ? [index] : []));
    expect(Math.max(...positions("output"))).toBeLessThan(Math.min(...positions("result")));

    peer.request("x2", { op: "exec", sandbox: SANDBOX, argv: ["cat"], stdin: Buffer.from("piped input\n").toString("base64") });
    expect(await peer.result("x2")).toEqual({ type: "result", id: "x2", ok: true, exitCode: 0 });
    expect(peer.output("x2", "stdout")).toBe("piped input\n");

    peer.request("x3", { op: "exec", sandbox: SANDBOX, argv: ["cat"] });
    expect(await peer.result("x3")).toEqual({ type: "result", id: "x3", ok: true, exitCode: 0 });
    expect(peer.output("x3", "stdout")).toBe("");

    peer.request("x4", {
      op: "exec",
      sandbox: SANDBOX,
      argv: ["sh", "-c", 'printf "%s|%s|%s|%s|%s" "${BOXCOMPUTE_RUNNER_TOKEN-unset}" "$BOXCOMPUTE_OPERATION" "$BOXCOMPUTE_SANDBOX_ID" "$BOXCOMPUTE_RUNNER_ID" "$BOXCOMPUTE_IMAGE"'],
    });
    expect(await peer.result("x4")).toMatchObject({ ok: true, exitCode: 0 });
    expect(peer.output("x4", "stdout")).toBe(`unset|exec|${SANDBOX}|rnr_test|node:22-bookworm`);

    peer.request("x5", { op: "exec", sandbox: SANDBOX, argv: ["sh", "-c", "kill -TERM $$"] });
    expect(await peer.result("x5")).toEqual({ type: "result", id: "x5", ok: true, exitCode: 143 });

    peer.request("e2", { op: "ensure", sandbox: "bxs-ffffffffffffffff" });
    expect(await peer.result("e2")).toEqual({ type: "result", id: "e2", ok: false, error: "disk full on test host" });

    peer.request("d1", { op: "delete", sandbox: SANDBOX });
    expect(await peer.result("d1")).toEqual({ type: "result", id: "d1", ok: true });

    const invalid: Array<[string, Frame, string]> = [
      ["v1", { op: "exec", sandbox: "bxs-0123456789ABCDEF", argv: ["true"] }, "invalid sandbox id"],
      ["v2", { op: "ensure", sandbox: "../../etc" }, "invalid sandbox id"],
      ["v3", { op: "exec", sandbox: SANDBOX, argv: [] }, "invalid argv"],
      ["v4", { op: "exec", sandbox: SANDBOX, argv: ["echo", 1] }, "invalid argv"],
      ["v5", { op: "exec", sandbox: SANDBOX, argv: "true" }, "invalid argv"],
      ["v6", { op: "exec", sandbox: SANDBOX, argv: ["cat"], stdin: "not base64!" }, "invalid stdin"],
      ["v7", { op: "snapshot", sandbox: SANDBOX }, "unsupported operation"],
    ];
    for (const [id, fields, error] of invalid) {
      peer.request(id, fields);
      expect(await peer.result(id)).toEqual({ type: "result", id, ok: false, error });
    }

    // Only valid requests reached the dispatch program, and never with the token.
    const calls = (await runner.dispatchLog()).trim().split("\n");
    expect(calls).toEqual([
      `ensure ${SANDBOX} rnr_test node:22-bookworm no-token`,
      ...["x1", "x2", "x3", "x4", "x5"].map(() => `exec ${SANDBOX} rnr_test node:22-bookworm no-token`),
      "ensure bxs-ffffffffffffffff rnr_test node:22-bookworm no-token",
      `delete ${SANDBOX} rnr_test node:22-bookworm no-token`,
    ]);

    runner.abort.abort();
    expect(await runner.done).toBe(0);
    expect((await until(() => peer.closed)).code).toBe(1000);
    expect(peers).toHaveLength(1);
    expect(runner.stdout.text).toContain(`exec ${SANDBOX} exit 3 (`);
    expect(runner.stdout.text).toContain("ensure bxs-ffffffffffffffff failed: disk full on test host (");
    expect(runner.stdout.text).toContain("Runner stopped.");
    expect(runner.stdout.text).not.toContain("printf hello");
    expect(`${runner.stdout.text}${runner.stderr.text}`).not.toContain(TOKEN);
  }, 20_000);

  it("logs exec arguments only with --verbose and redacts the token from them", async () => {
    const url = listen();
    const { runner, peer } = await welcomed(url, { verbose: true });
    peer.request("v", { op: "exec", sandbox: SANDBOX, argv: ["echo", `token=${TOKEN}`] });
    await peer.result("v");
    await until(() => runner.stdout.text.includes("exec bxs-"));
    expect(runner.stdout.text).toContain('["echo","token=[redacted]"]');
    expect(runner.stdout.text).not.toContain(TOKEN);
  }, 10_000);

  it("runs at most eight requests at once, queues the rest and cancels queued and running work", async () => {
    const url = listen();
    const { runner, peer } = await welcomed(url, {}, {}, 50);
    const execLines = async () => (await runner.dispatchLog()).split("\n").filter((line) => line.startsWith("exec ")).length;
    const ids = Array.from({ length: 9 }, (_, index) => `s${index}`);
    for (const id of ids) peer.request(id, { op: "exec", sandbox: SANDBOX, argv: ["sleep", "30"] });
    await until(async () => (await execLines()) === 8);
    await sleep(300);
    expect(await execLines()).toBe(8);

    peer.send({ type: "cancel", id: "s8" });
    expect(await peer.result("s8")).toEqual({ type: "result", id: "s8", ok: false, error: "cancelled" });
    peer.send({ type: "cancel", id: "s0" });
    expect(await peer.result("s0")).toEqual({ type: "result", id: "s0", ok: false, error: "cancelled" });

    // s0's slot frees once its process is killed; the next request runs.
    peer.request("after", { op: "exec", sandbox: SANDBOX, argv: ["sh", "-c", "printf ran"] });
    expect(await peer.result("after")).toEqual({ type: "result", id: "after", ok: true, exitCode: 0 });
    expect(peer.output("after", "stdout")).toBe("ran");

    for (const id of ids.slice(1, 8)) peer.send({ type: "cancel", id });
    for (const id of ids.slice(1, 8)) expect(await peer.result(id)).toMatchObject({ ok: false, error: "cancelled" });
    peer.send({ type: "cancel", id: "unknown" });
    await sleep(300);
    for (const id of [...ids, "after"]) expect(peer.results(id)).toHaveLength(1);
    expect(peer.results("unknown")).toHaveLength(0);
    expect(runner.stdout.text).toContain(`exec ${SANDBOX} cancelled before it started (`);
    expect(runner.stdout.text).toContain(`exec ${SANDBOX} cancelled (`);
  }, 20_000);

  it("honours a lower concurrency limit from the welcome", async () => {
    const url = listen();
    const { runner, peer } = await welcomed(url, {}, {}, 2);
    for (const id of ["a", "b", "c"]) peer.request(id, { op: "exec", sandbox: SANDBOX, argv: ["sleep", "30"] });
    const execLines = async () => (await runner.dispatchLog()).split("\n").filter((line) => line.startsWith("exec ")).length;
    await until(async () => (await execLines()) === 2);
    await sleep(300);
    expect(await execLines()).toBe(2);
    peer.send({ type: "cancel", id: "a" });
    await until(async () => (await execLines()) === 3);
  }, 10_000);

  it("splits output into bounded chunks and stops forwarding past the budget but reports the exit code", async () => {
    const url = listen();
    const { runner, peer } = await welcomed(url, {}, { limits: { outputChunk: 4_096, outputBudget: 10_000 } });
    peer.request("big", { op: "exec", sandbox: SANDBOX, argv: ["sh", "-c", "head -c 50000 /dev/zero; exit 7"] });
    expect(await peer.result("big")).toEqual({ type: "result", id: "big", ok: true, exitCode: 7 });
    const chunks = peer.frames
      .filter((frame) => frame.type === "output" && frame.id === "big")
      .map((frame) => Buffer.from(frame.data as string, "base64").length);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(4_096);
    expect(chunks.reduce((sum, size) => sum + size, 0)).toBe(10_000);
    expect(runner.stdout.text).toContain("discarding the rest");
  }, 10_000);

  it("exits on 4401 without reconnecting and says what to do", async () => {
    const url = listen();
    const { peers } = servers.get(url)!;
    const runner = await startRunner(url);
    const peer = await until(() => peers[0]);
    await peer.next((frame) => frame.type === "hello");
    peer.close(4401, "invalid token");
    expect(await runner.done).toBe(1);
    expect(runner.stderr.text).toContain("BoxCompute did not accept BOXCOMPUTE_RUNNER_TOKEN");
    expect(runner.stderr.text).toContain("(4401: invalid token)");
    await sleep(1_500);
    expect(peers).toHaveLength(1);
  }, 10_000);

  it("reconnects 1–3 seconds after the server restarts (1012)", async () => {
    const url = listen();
    const { runner, peer, peers } = await welcomed(url);
    peer.close(1012, "restarting");
    const second = await until(() => peers[1], 5_000);
    await second.next((frame) => frame.type === "hello");
    expect(runner.stderr.text).toContain("BoxCompute is restarting. Reconnecting in 1s.");
    second.send({ type: "welcome", runnerId: "rnr_test", name: "Test runner", maxConcurrent: 8 });
    await until(() => runner.stdout.text.includes('Reconnected as "Test runner".'));
  }, 10_000);

  it("drops a silent connection, kills its commands and reconnects", async () => {
    const url = listen();
    const { runner, peer, peers } = await welcomed(url, {}, { timing: { silenceMs: 500, backoffMinMs: 50 } });
    peer.request("long", { op: "exec", sandbox: SANDBOX, argv: ["sleep", "30"] });
    await until(async () => (await runner.dispatchLog()).includes("exec "));
    const second = await until(() => peers[1], 5_000);
    await second.next((frame) => frame.type === "hello");
    expect(runner.stderr.text).toContain("No message from BoxCompute for 1s. Reconnecting in 1s.");
    await until(() => runner.stdout.text.includes(`exec ${SANDBOX} interrupted (`));
    expect(peer.results("long")).toHaveLength(0);
    expect(second.results("long")).toHaveLength(0);
  }, 10_000);
});

describe("bxc runner helpers", () => {
  it("derives the WebSocket URL and refuses plain ws:// beyond loopback", () => {
    expect(runnerSocketUrl("https://app.boxcompute.ai")).toBe("wss://app.boxcompute.ai/api/runners/connect");
    expect(runnerSocketUrl("https://box.example.com:8443")).toBe("wss://box.example.com:8443/api/runners/connect");
    expect(runnerSocketUrl("http://localhost:3000")).toBe("ws://localhost:3000/api/runners/connect");
    expect(runnerSocketUrl("http://127.0.0.1:3000")).toBe("ws://127.0.0.1:3000/api/runners/connect");
    expect(runnerSocketUrl("http://[::1]:3000")).toBe("ws://[::1]:3000/api/runners/connect");
    expect(() => runnerSocketUrl("http://box.example.com")).toThrow("needs an https:// BoxCompute URL");
  });

  it("parses idle-stop durations", () => {
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("90s")).toBe(90_000);
    for (const value of ["", "30", "m", "-5m", "1.5h", "30 m", "5d"]) expect(() => parseDuration(value)).toThrow("--idle-stop");
  });

  it("validates requests before anything runs", () => {
    expect(parseRequest({ op: "ensure", sandbox: SANDBOX })).toBeUndefined();
    expect(parseRequest({ id: 7, op: "ensure", sandbox: SANDBOX })).toBeUndefined();
    expect(parseRequest({ id: "a", op: "exec", sandbox: SANDBOX, argv: ["a\0b"] })).toEqual({ id: "a", error: "invalid argv" });
    expect(parseRequest({ id: "a", op: "exec", sandbox: SANDBOX, argv: ["cat"], stdin: "abc" })).toEqual({ id: "a", error: "invalid stdin" });
    expect(parseRequest({ id: "a", op: "exec", sandbox: SANDBOX, argv: ["cat"], stdin: "a=bc" })).toEqual({ id: "a", error: "invalid stdin" });
    expect(parseRequest({ id: "a", op: "exec", sandbox: "bxs-0123456789abcde", argv: ["cat"] })).toEqual({ id: "a", error: "invalid sandbox id" });
    expect(parseRequest({ id: "a", op: "exec", sandbox: SANDBOX, argv: ["cat"], stdin: "aGk=" })?.request?.stdin.toString()).toBe("hi");
    expect(parseRequest({ id: "a", op: "exec", sandbox: SANDBOX, argv: ["cat"], stdin: null })?.request?.stdin.length).toBe(0);
  });

  it("keeps messages to one printable line without the token", () => {
    expect(safeText(`line one\n\u001b[31m${TOKEN}\u0000 tail`, 500, TOKEN)).toBe("line one [31m[redacted] tail");
    expect(safeText("x".repeat(600), 500)).toHaveLength(500);
  });
});

describe("bxc runner command", () => {
  const io = () => ({ stdout: new PassThrough(), stderr: new PassThrough() });
  const base = { env: { BOXCOMPUTE_RUNNER_TOKEN: TOKEN }, loadSavedUrl: async () => null, syncManagedSkills: async () => [] };

  it("reads the token only from the environment and passes the parsed options", async () => {
    const seen: Array<{ options: RunnerOptions; env: NodeJS.ProcessEnv }> = [];
    const runner = (async (options: RunnerOptions, dependencies: RunnerDependencies) => {
      seen.push({ options, env: dependencies.env });
      return 0;
    }) as typeof runRunner;
    expect(await runCli(["runner", "--image", "python:3.13", "--idle-stop", "2h", "--url", "http://localhost:3000", "--verbose"], {
      ...base, io: io(), runner,
    })).toBe(0);
    expect(seen[0]!.options).toMatchObject({
      url: "http://localhost:3000",
      token: TOKEN,
      image: "python:3.13",
      imageChosen: true,
      dispatch: null,
      idleStopMs: 7_200_000,
      verbose: true,
    });
    expect(await runCli(["runner"], { ...base, io: io(), runner, loadSavedUrl: async () => "https://box.example.com" })).toBe(0);
    expect(seen[1]!.options).toMatchObject({
      url: "https://box.example.com",
      image: "node:22-bookworm",
      imageChosen: false,
      idleStopMs: 1_800_000,
      verbose: false,
    });
    expect(await runCli(["runner", "--dispatch", "./dispatch.sh"], { ...base, io: io(), runner })).toBe(0);
    expect(seen[2]!.options).toMatchObject({ url: "https://app.boxcompute.ai", dispatch: "./dispatch.sh" });
  });

  it("refuses to start without a runner token, Node.js 22 or valid options", async () => {
    const runner = (async () => { throw new Error("must not start"); }) as unknown as typeof runRunner;
    await expect(runCli(["runner"], { ...base, env: {}, io: io(), runner })).rejects.toThrow(
      "BOXCOMPUTE_RUNNER_TOKEN is not set. Create a runner in BoxCompute (Settings → Runners)",
    );
    await expect(runCli(["runner"], { ...base, env: { BOXCOMPUTE_RUNNER_TOKEN: "bc_live_cli_key" }, io: io(), runner }))
      .rejects.toThrow("is not a runner token");
    await expect(runCli(["runner"], { ...base, io: io(), runner, webSocket: null })).rejects.toThrow("bxc runner needs Node.js 22 or newer.");
    await expect(runCli(["--json", "runner"], { ...base, io: io(), runner })).rejects.toThrow("does not support --json");
    await expect(runCli(["runner", "--token", TOKEN], { ...base, io: io(), runner })).rejects.toThrow("Unknown runner option: --token");
    await expect(runCli(["runner", "--idle-stop", "soon"], { ...base, io: io(), runner })).rejects.toThrow("--idle-stop must be a duration");
    await expect(runCli(["runner", "--dispatch", "./d.sh", "--idle-stop", "5m"], { ...base, io: io(), runner }))
      .rejects.toThrow("--idle-stop applies only to the built-in Docker dispatch");
    await expect(runCli(["runner", "--image", "-v/:/host"], { ...base, io: io(), runner })).rejects.toThrow("--image must be");
  });

  it("documents the command", async () => {
    const help = io();
    expect(await runCli(["runner", "--help"], { env: {}, io: help })).toBe(0);
    const text = help.stdout.read().toString();
    expect(text).toContain("BOXCOMPUTE_RUNNER_TOKEN");
    expect(text).toContain("--idle-stop DURATION");
    expect(text).toContain("--dispatch PROGRAM");
    const root = io();
    expect(await runCli(["--help"], { env: {}, io: root })).toBe(0);
    expect(root.stdout.read().toString()).toContain("runner ");
  });
});
