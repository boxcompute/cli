import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDispatcher,
  dockerArgs,
  dockerWorkspaceVolume,
  lastLine,
  resolveProgram,
  withoutRunnerToken,
  type OutputSink,
} from "../src/runner-dispatch.js";

const SANDBOX = "bxs-0123456789abcdef";
const TOKEN = "bxr_test_0123456789abcdef_SECRET";
const FAKE_DOCKER = fileURLToPath(new URL("./fixtures/fake-docker.sh", import.meta.url));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fakeDocker(extraEnv: NodeJS.ProcessEnv = {}, idleStopMs = 60_000) {
  const directory = await mkdtemp(path.join(tmpdir(), "bxc-docker-"));
  directories.push(directory);
  const logFile = path.join(directory, "docker.log");
  const stateFile = path.join(directory, "state");
  let clock = 0;
  const lines: string[] = [];
  const dispatcher = createDispatcher({
    program: null,
    image: "node:22-bookworm",
    idleStopMs,
    env: {
      PATH: process.env.PATH,
      BOXCOMPUTE_RUNNER_TOKEN: TOKEN,
      FAKE_DOCKER_LOG: logFile,
      FAKE_DOCKER_STATE: stateFile,
      ...extraEnv,
    },
    log: (line) => lines.push(line),
    docker: FAKE_DOCKER,
    now: () => clock,
  });
  return {
    dispatcher,
    lines,
    setClock: (value: number) => { clock = value; },
    calls: async () => (await readFile(logFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean),
    reset: () => writeFile(logFile, ""),
    stopBehindTheRunnersBack: () => writeFile(stateFile, "stopped\n"),
  };
}

function collector() {
  const text = { stdout: "", stderr: "" };
  const sink: OutputSink = (stream, chunk) => {
    text[stream] += chunk.toString("utf8");
    return undefined;
  };
  return { text, sink };
}

describe("Docker dispatch argv", () => {
  it("builds every Docker call as an argument vector", () => {
    expect(dockerWorkspaceVolume(SANDBOX)).toBe("bxs-0123456789abcdef-workspace");
    expect(dockerArgs.version()).toEqual(["version", "--format", "{{.Server.Version}}"]);
    expect(dockerArgs.inspect(SANDBOX)).toEqual(["inspect", "--type", "container", "--format", "{{.State.Running}}", SANDBOX]);
    expect(dockerArgs.run(SANDBOX, "rnr_abc", "node:22-bookworm")).toEqual([
      "run", "-d",
      "--name", SANDBOX,
      "--label", "com.boxcompute.runner=rnr_abc",
      "--label", `com.boxcompute.sandbox=${SANDBOX}`,
      "--init",
      "-w", "/workspace",
      "-v", "bxs-0123456789abcdef-workspace:/workspace",
      "node:22-bookworm", "sleep", "infinity",
    ]);
    expect(dockerArgs.toolCheck(SANDBOX)).toEqual(["exec", SANDBOX, "sh", "-c", "command -v bash && command -v python3"]);
    expect(dockerArgs.start(SANDBOX)).toEqual(["start", SANDBOX]);
    // The command's argv follows the container name untouched, even when it looks like an option.
    expect(dockerArgs.exec(SANDBOX, ["--help", "a b", "$(id)"], "e1")).toEqual([
      "exec", "-i", "--env", "BOXCOMPUTE_EXEC_ID=e1", SANDBOX, "--help", "a b", "$(id)",
    ]);
    const kill = dockerArgs.killExec(SANDBOX, "e1");
    expect(kill.slice(0, 4)).toEqual(["exec", SANDBOX, "sh", "-c"]);
    expect(kill.slice(-2)).toEqual(["sh", "e1"]);
    expect(kill[4]).toContain('grep -qxF "BOXCOMPUTE_EXEC_ID=$1"');
    expect(dockerArgs.stop(SANDBOX)).toEqual(["stop", "-t", "10", SANDBOX]);
    expect(dockerArgs.removeContainer(SANDBOX)).toEqual(["rm", "-f", SANDBOX]);
    expect(dockerArgs.removeVolume(SANDBOX)).toEqual(["volume", "rm", "-f", "bxs-0123456789abcdef-workspace"]);
  });

  it("removes the runner token from child environments", () => {
    expect(withoutRunnerToken({ PATH: "/bin", BOXCOMPUTE_RUNNER_TOKEN: TOKEN, BOXCOMPUTE_URL: "https://x" }))
      .toEqual({ PATH: "/bin", BOXCOMPUTE_URL: "https://x" });
  });

  it("reports the last meaningful stderr line", () => {
    expect(lastLine("first\nsecond\n\n  \n")).toBe("second");
    expect(lastLine("docker: Error response from daemon: denied.\nSee 'docker run --help'.\n", /^See 'docker/)).toBe(
      "docker: Error response from daemon: denied.",
    );
  });
});

describe("Docker dispatch", () => {
  it("creates, reuses, idle-stops, restarts and deletes a sandbox without leaking the token", async () => {
    const docker = await fakeDocker();
    await docker.dispatcher.check();
    await docker.dispatcher.ensure(SANDBOX, "rnr_abc");
    expect(await docker.calls()).toEqual([
      "version --format {{.Server.Version}}",
      `inspect --type container --format {{.State.Running}} ${SANDBOX}`,
      `run -d --name ${SANDBOX} --label com.boxcompute.runner=rnr_abc --label com.boxcompute.sandbox=${SANDBOX} ` +
        `--init -w /workspace -v ${SANDBOX}-workspace:/workspace node:22-bookworm sleep infinity`,
      `exec ${SANDBOX} sh -c command -v bash && command -v python3`,
    ]);

    await docker.reset();
    await docker.dispatcher.ensure(SANDBOX, "rnr_abc");
    expect(await docker.calls()).toEqual([`inspect --type container --format {{.State.Running}} ${SANDBOX}`]);

    await docker.reset();
    const output = collector();
    const status = await docker.dispatcher.exec(
      SANDBOX, "rnr_abc", ["sh", "-c", 'printf "%s" "${BOXCOMPUTE_RUNNER_TOKEN-unset}"; printf err >&2; exit 4'],
      Buffer.alloc(0), output.sink, new AbortController().signal,
    );
    expect(status).toBe(4);
    expect(output.text).toEqual({ stdout: "unset", stderr: "err" });
    const [execCall] = await docker.calls();
    expect(execCall).toMatch(new RegExp(`^exec -i --env BOXCOMPUTE_EXEC_ID=[0-9a-f-]{36} ${SANDBOX} sh -c `));

    // Not idle yet, then idle: stopped once, and the volume stays.
    await docker.reset();
    docker.setClock(59_999);
    await docker.dispatcher.sweep();
    expect(await docker.calls()).toEqual([]);
    docker.setClock(60_000);
    await docker.dispatcher.sweep();
    await docker.dispatcher.sweep();
    expect(await docker.calls()).toEqual([`stop -t 10 ${SANDBOX}`]);
    expect(docker.lines).toEqual([`idle-stop ${SANDBOX} after 1m without commands; files kept`]);

    // A command after idle stop starts the container again first.
    await docker.reset();
    const again = collector();
    expect(await docker.dispatcher.exec(SANDBOX, "rnr_abc", ["printf", "back"], Buffer.alloc(0), again.sink, new AbortController().signal)).toBe(0);
    expect(again.text.stdout).toBe("back");
    const restarted = await docker.calls();
    expect(restarted.slice(0, 2)).toEqual([`inspect --type container --format {{.State.Running}} ${SANDBOX}`, `start ${SANDBOX}`]);

    // A running command is never idle-stopped.
    await docker.reset();
    const running = docker.dispatcher.exec(SANDBOX, "rnr_abc", ["sleep", "0.5"], Buffer.alloc(0), collector().sink, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    docker.setClock(10_000_000);
    await docker.dispatcher.sweep();
    expect(await running).toBe(0);
    expect((await docker.calls()).filter((call) => call.startsWith("stop"))).toEqual([]);

    // Docker stopped it on its own (daemon restart): a command more than 10 s
    // after the last check inspects and starts it before running.
    await docker.stopBehindTheRunnersBack();
    docker.setClock(10_000_000 + 9_999);
    await docker.reset();
    expect(await docker.dispatcher.exec(SANDBOX, "rnr_abc", ["true"], Buffer.alloc(0), collector().sink, new AbortController().signal)).toBe(0);
    expect((await docker.calls())[0]).toMatch(/^exec -i /);
    await docker.stopBehindTheRunnersBack();
    docker.setClock(10_000_000 + 9_999 + 10_000);
    await docker.reset();
    expect(await docker.dispatcher.exec(SANDBOX, "rnr_abc", ["true"], Buffer.alloc(0), collector().sink, new AbortController().signal)).toBe(0);
    expect((await docker.calls()).slice(0, 2)).toEqual([`inspect --type container --format {{.State.Running}} ${SANDBOX}`, `start ${SANDBOX}`]);

    await docker.reset();
    await docker.dispatcher.remove(SANDBOX, "rnr_abc");
    await docker.dispatcher.remove(SANDBOX, "rnr_abc");
    expect(await docker.calls()).toEqual([
      `rm -f ${SANDBOX}`, `volume rm -f ${SANDBOX}-workspace`,
      `rm -f ${SANDBOX}`, `volume rm -f ${SANDBOX}-workspace`,
    ]);
    await expect(docker.dispatcher.exec(SANDBOX, "rnr_abc", ["true"], Buffer.alloc(0), collector().sink, new AbortController().signal))
      .rejects.toThrow("does not exist on the runner");

    expect((await readFile(path.join(directories[0]!, "docker.log"), "utf8"))).not.toContain("TOKEN-LEAKED");
    await docker.dispatcher.shutdown();
  }, 15_000);

  it("kills a cancelled command inside its container as well as the local client", async () => {
    const docker = await fakeDocker();
    await docker.dispatcher.ensure(SANDBOX, "rnr_abc");
    await docker.reset();
    const abort = new AbortController();
    const started = Date.now();
    const running = docker.dispatcher.exec(SANDBOX, "rnr_abc", ["sleep", "30"], Buffer.alloc(0), collector().sink, abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 200));
    abort.abort();
    expect(await running).toBe(137);
    expect(Date.now() - started).toBeLessThan(5_000);
    await docker.dispatcher.shutdown();
    const log = (await docker.calls()).join("\n");
    const execId = /BOXCOMPUTE_EXEC_ID=([0-9a-f-]{36})/.exec(log)?.[1];
    expect(execId).toBeDefined();
    expect(log).toContain(`exec ${SANDBOX} sh -c for p in /proc/[0-9]*; do`);
    expect(log).toContain(`exit 0 sh ${execId}`);
  }, 10_000);

  it("explains Docker, image and tool failures", async () => {
    const down = await fakeDocker({ FAKE_DOCKER_DOWN: "1" });
    await expect(down.dispatcher.check()).rejects.toThrow(
      "Docker is not reachable (Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?). Start Docker",
    );

    const missing = createDispatcher({ program: null, image: "node:22-bookworm", idleStopMs: 0, env: {}, log: () => undefined, docker: "/nonexistent/docker" });
    await expect(missing.check()).rejects.toThrow("Docker is not installed or not on PATH");

    const denied = await fakeDocker({ FAKE_DOCKER_PULL_DENIED: "1" });
    await expect(denied.dispatcher.ensure(SANDBOX, "rnr_abc")).rejects.toThrow(
      "docker: Error response from daemon: pull access denied for private/image, repository does not exist or may require 'docker login'.",
    );

    const bare = await fakeDocker({ FAKE_DOCKER_TOOLS_EXIT: "1" });
    await expect(bare.dispatcher.ensure(SANDBOX, "rnr_abc")).rejects.toThrow(
      "The image node:22-bookworm needs bash and python3. Choose another with --image.",
    );
    expect((await bare.calls()).at(-1)).toBe(`rm -f ${SANDBOX}`);
  }, 10_000);
});

describe("custom dispatch program", () => {
  it("resolves the program to an absolute executable path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bxc-dispatch-"));
    directories.push(directory);
    const program = path.join(directory, "dispatch-test");
    await writeFile(program, "#!/bin/sh\nexit 0\n");
    await expect(Promise.resolve().then(() => resolveProgram(program, {}))).rejects.toThrow("is not an executable file");
    await chmod(program, 0o755);
    expect(resolveProgram(program, {})).toBe(program);
    expect(resolveProgram("dispatch-test", { PATH: `/nonexistent${path.delimiter}${directory}` })).toBe(program);
    expect(() => resolveProgram("dispatch-test", { PATH: "/nonexistent" })).toThrow("was not found on PATH");
  });

  it("runs the README's example dispatch.sh", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const script = /```sh\n(#!\/bin\/sh\n# bxc runner --dispatch \.\/dispatch\.sh\n[\s\S]*?)```/.exec(readme)?.[1];
    expect(script).toBeDefined();
    const directory = await mkdtemp(path.join(tmpdir(), "bxc-readme-dispatch-"));
    directories.push(directory);
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await symlink(FAKE_DOCKER, path.join(bin, "docker"));
    const program = path.join(directory, "dispatch.sh");
    await writeFile(program, script!, { mode: 0o755 });
    const logFile = path.join(directory, "docker.log");
    const make = (extra: NodeJS.ProcessEnv = {}) => createDispatcher({
      program,
      image: "node:22-bookworm",
      idleStopMs: 0,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        BOXCOMPUTE_RUNNER_TOKEN: TOKEN,
        FAKE_DOCKER_LOG: logFile,
        FAKE_DOCKER_STATE: path.join(directory, "state"),
        ...extra,
      },
      log: () => undefined,
    });
    const dispatcher = make();
    await dispatcher.check();
    await dispatcher.ensure(SANDBOX, "rnr_abc");
    await dispatcher.ensure(SANDBOX, "rnr_abc");
    const output = collector();
    expect(await dispatcher.exec(SANDBOX, "rnr_abc", ["printf", "hi"], Buffer.alloc(0), output.sink, new AbortController().signal)).toBe(0);
    expect(output.text.stdout).toBe("hi");
    await dispatcher.remove(SANDBOX, "rnr_abc");
    await dispatcher.remove(SANDBOX, "rnr_abc");
    const inspect = `inspect --type container --format {{.State.Running}} ${SANDBOX}`;
    expect((await readFile(logFile, "utf8")).trim().split("\n")).toEqual([
      inspect,
      `run -d --name ${SANDBOX} --init -w /workspace --label com.boxcompute.runner=rnr_abc ` +
        `--label com.boxcompute.sandbox=${SANDBOX} -v ${SANDBOX}-workspace:/workspace node:22-bookworm sleep infinity`,
      `exec ${SANDBOX} sh -c command -v bash && command -v python3`,
      inspect,
      `exec -i ${SANDBOX} printf hi`,
      `inspect --type container ${SANDBOX}`,
      `rm -f ${SANDBOX}`,
      `volume rm -f ${SANDBOX}-workspace`,
      `inspect --type container ${SANDBOX}`,
      `volume rm -f ${SANDBOX}-workspace`,
    ]);
    const bare = make({ FAKE_DOCKER_TOOLS_EXIT: "1", FAKE_DOCKER_STATE: path.join(directory, "bare-state") });
    await bare.check();
    await expect(bare.ensure(SANDBOX, "rnr_abc")).rejects.toThrow(
      "The image node:22-bookworm needs bash and python3",
    );
    await dispatcher.shutdown();
  }, 10_000);
});
