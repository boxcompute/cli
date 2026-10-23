import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";

export const RUNNER_TOKEN_ENV = "BOXCOMPUTE_RUNNER_TOKEN";

export type OutputStream = "stdout" | "stderr";
/** Receives raw output. A returned promise pauses that stream until it settles (socket backpressure). */
export type OutputSink = (stream: OutputStream, chunk: Buffer) => Promise<void> | undefined;

export interface Dispatcher {
  readonly mode: "docker" | "custom";
  /** Startup check: Docker answers, or the dispatch program exists. */
  check(): Promise<void>;
  ensure(sandbox: string, runnerId: string): Promise<void>;
  remove(sandbox: string, runnerId: string): Promise<void>;
  exec(
    sandbox: string,
    runnerId: string,
    argv: string[],
    stdin: Buffer,
    output: OutputSink,
    signal: AbortSignal,
  ): Promise<number>;
  /** Stops containers that have been idle longer than --idle-stop. */
  sweep(): Promise<void>;
  /** Kills every child process and waits briefly for in-container cleanup. */
  shutdown(): Promise<void>;
}

export type DispatcherOptions = {
  /** Custom dispatch program, or null for the built-in Docker dispatch. */
  program: string | null;
  image: string;
  idleStopMs: number;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  docker?: string;
  now?: () => number;
  spawn?: typeof spawn;
};

const GROUP_KILL = process.platform !== "win32";
// A command that exits while a background child still holds its stdout would
// otherwise keep the request open forever.
const EXIT_GRACE_MS = 2_000;
const CLEANUP_WAIT_MS = 5_000;
// Docker may have stopped a container behind our back (daemon restart, Docker
// Desktop update); re-check its state before a command when it is this stale.
const RECHECK_MS = 10_000;

/** The runner token authenticates this machine to BoxCompute; nothing it starts may read it. */
export function withoutRunnerToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== RUNNER_TOKEN_ENV));
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const env = withoutRunnerToken(options.env);
  const processes = new Processes(options.spawn ?? spawn);
  if (options.program !== null) return new CustomDispatcher(options.program, options.image, env, processes);
  return new DockerDispatcher({
    command: options.docker ?? "docker",
    image: options.image,
    idleStopMs: options.idleStopMs,
    log: options.log,
    now: options.now ?? Date.now,
  }, env, processes);
}

export function dockerWorkspaceVolume(sandbox: string): string {
  return `${sandbox}-workspace`;
}

// Kills every process in the container that inherited this exec's marker.
// Killing the local `docker exec` client alone leaves the command running.
const KILL_EXEC_SCRIPT = [
  "for p in /proc/[0-9]*; do",
  "  if tr '\\0' '\\n' 2>/dev/null < \"$p/environ\" | grep -qxF \"BOXCOMPUTE_EXEC_ID=$1\"; then kill -9 \"${p#/proc/}\" 2>/dev/null; fi",
  "done",
  "exit 0",
].join("\n");

/** Docker CLI argument vectors. Every value is one argv element; nothing passes through a shell on the host. */
export const dockerArgs = {
  version: (): string[] => ["version", "--format", "{{.Server.Version}}"],
  inspect: (sandbox: string): string[] => ["inspect", "--type", "container", "--format", "{{.State.Running}}", sandbox],
  run: (sandbox: string, runnerId: string, image: string): string[] => [
    "run", "-d",
    "--name", sandbox,
    "--label", `com.boxcompute.runner=${runnerId}`,
    "--label", `com.boxcompute.sandbox=${sandbox}`,
    "--init",
    "-w", "/workspace",
    "-v", `${dockerWorkspaceVolume(sandbox)}:/workspace`,
    image, "sleep", "infinity",
  ],
  toolCheck: (sandbox: string): string[] => ["exec", sandbox, "sh", "-c", "command -v bash && command -v python3"],
  start: (sandbox: string): string[] => ["start", sandbox],
  exec: (sandbox: string, argv: string[], execId: string): string[] => [
    "exec", "-i", "--env", `BOXCOMPUTE_EXEC_ID=${execId}`, sandbox, ...argv,
  ],
  killExec: (sandbox: string, execId: string): string[] => ["exec", sandbox, "sh", "-c", KILL_EXEC_SCRIPT, "sh", execId],
  stop: (sandbox: string): string[] => ["stop", "-t", "10", sandbox],
  removeContainer: (sandbox: string): string[] => ["rm", "-f", sandbox],
  removeVolume: (sandbox: string): string[] => ["volume", "rm", "-f", dockerWorkspaceVolume(sandbox)],
};

/** Last non-empty line of a program's stderr, which is where CLIs put the reason they failed. */
export function lastLine(text: string, skip?: RegExp): string {
  const lines = text.split(/\r?\n|\r/).map((line) => line.trim()).filter((line) => line && !skip?.test(line));
  return lines.at(-1) ?? "";
}

// Docker ends most errors with "See 'docker run --help'.", which says nothing about the failure.
const dockerError = (stderr: string) => lastLine(stderr, /^(See|Run) '?docker\b.*--help/);

/** Absolute path of an executable dispatch program, so later spawns do not depend on PATH or cwd. */
export function resolveProgram(program: string, env: NodeJS.ProcessEnv): string {
  const executable = (file: string) => {
    try {
      if (!statSync(file).isFile()) return false;
      accessSync(file, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (program.includes("/") || program.includes(path.sep)) {
    const resolved = path.resolve(program);
    if (executable(resolved)) return resolved;
    throw new Error(`--dispatch ${program} is not an executable file. Make it executable (chmod +x) or choose another program.`);
  }
  if (process.platform === "win32") return program;
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, program);
    if (executable(candidate)) return candidate;
  }
  throw new Error(`--dispatch ${program} was not found on PATH.`);
}

function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal ? osConstants.signals[signal] : undefined;
  return number ? 128 + number : 1;
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (GROUP_KILL && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group is already gone; fall back to the direct child.
    }
  }
  child.kill("SIGKILL");
}

class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.limit) {
      this.size -= this.chunks.shift()!.length;
    }
  }
  text(): string {
    return Buffer.concat(this.chunks).subarray(-this.limit).toString("utf8");
  }
}

type Collected = { code: number; stdout: string; stderr: string };

/** Spawns children in their own process group (no shell) so one SIGKILL reaches everything they started. */
class Processes {
  private readonly live = new Set<ChildProcess>();
  private readonly cleanups = new Set<Promise<void>>();
  constructor(private readonly spawnImpl: typeof spawn) {}

  private start(command: string, args: string[], env: NodeJS.ProcessEnv, stdio: StdioOptions): ChildProcess {
    const child = this.spawnImpl(command, args, { env, stdio, detached: GROUP_KILL, windowsHide: true });
    this.live.add(child);
    const forget = () => { this.live.delete(child); };
    child.once("exit", forget);
    child.once("error", forget);
    return child;
  }

  collect(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<Collected> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.start(command, args, env, ["ignore", "pipe", "pipe"]);
      } catch (error) {
        reject(error);
        return;
      }
      const stdout = new Tail(65_536);
      const stderr = new Tail(16_384);
      child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code: exitStatus(code, signal), stdout: stdout.text(), stderr: stderr.text() }));
    });
  }

  stream(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    stdin: Buffer,
    output: OutputSink,
    signal: AbortSignal,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      let child: ChildProcess;
      try {
        child = this.start(command, args, env, ["pipe", "pipe", "pipe"]);
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const abort = () => killTree(child);
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(grace);
        signal.removeEventListener("abort", abort);
        settle();
      };
      signal.addEventListener("abort", abort, { once: true });
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(stdin);
      for (const name of ["stdout", "stderr"] as const) {
        const source = child[name]!;
        source.on("data", (chunk: Buffer) => {
          const pending = output(name, chunk);
          if (!pending) return;
          source.pause();
          void pending.then(() => source.resume());
        });
      }
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", () => {
        grace = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, EXIT_GRACE_MS);
      });
      child.once("close", (code, signalName) => finish(() => resolve(exitStatus(code, signalName))));
    });
  }

  /** Best-effort follow-up that must outlive a kill-all, such as stopping a cancelled command in its container. */
  detach(command: string, args: string[], env: NodeJS.ProcessEnv): void {
    let child: ChildProcess;
    try {
      child = this.spawnImpl(command, args, { env, stdio: "ignore", detached: GROUP_KILL, windowsHide: true });
    } catch {
      return;
    }
    const done = new Promise<void>((resolve) => {
      child.once("error", () => resolve());
      child.once("exit", () => resolve());
    });
    this.cleanups.add(done);
    void done.then(() => this.cleanups.delete(done));
    child.unref();
  }

  async stop(): Promise<void> {
    for (const child of this.live) killTree(child);
    const pending = [...this.cleanups];
    if (!pending.length) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLEANUP_WAIT_MS);
      void Promise.allSettled(pending).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Runs lifecycle work for one sandbox at a time, so ensure, idle stop and delete never interleave. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

type Tracked = { lastActive: number; verifiedAt: number; running: number; stopped: boolean };
type DockerSettings = {
  command: string;
  image: string;
  idleStopMs: number;
  log: (line: string) => void;
  now: () => number;
};

class DockerDispatcher implements Dispatcher {
  readonly mode = "docker" as const;
  // Sandboxes this process ensured or started; only these are idle-stopped.
  private readonly tracked = new Map<string, Tracked>();
  private readonly lock = new KeyedLock();
  private sweeping = false;

  constructor(
    private readonly settings: DockerSettings,
    private readonly env: NodeJS.ProcessEnv,
    private readonly processes: Processes,
  ) {}

  async check(): Promise<void> {
    let result: Collected;
    try {
      result = await this.docker(dockerArgs.version());
    } catch {
      throw new Error("Docker is not installed or not on PATH. Install Docker, or use --dispatch with your own program.");
    }
    if (result.code !== 0) {
      const detail = dockerError(result.stderr);
      throw new Error(
        `Docker is not reachable${detail ? ` (${detail})` : ""}. ` +
        "Start Docker and check that `docker version` works for this user, or use --dispatch.",
      );
    }
  }

  ensure(sandbox: string, runnerId: string): Promise<void> {
    return this.lock.run(sandbox, async () => {
      const state = await this.state(sandbox);
      if (state === "missing") {
        await this.must(dockerArgs.run(sandbox, runnerId, this.settings.image));
        const tools = await this.docker(dockerArgs.toolCheck(sandbox));
        if (tools.code !== 0) {
          // Leave the volume, but not a container that the next ensure would accept as ready.
          await this.docker(dockerArgs.removeContainer(sandbox)).catch(() => undefined);
          throw new Error(`The image ${this.settings.image} needs bash and python3. Choose another with --image.`);
        }
      } else if (state === "stopped") {
        await this.must(dockerArgs.start(sandbox));
      }
      this.touch(sandbox);
    });
  }

  async exec(
    sandbox: string,
    _runnerId: string,
    argv: string[],
    stdin: Buffer,
    output: OutputSink,
    signal: AbortSignal,
  ): Promise<number> {
    const entry = await this.lock.run(sandbox, async () => {
      let current = this.tracked.get(sandbox);
      if (!current || current.stopped || this.settings.now() - current.verifiedAt >= RECHECK_MS) {
        // Idle stop, a runner restart or a Docker restart may have left the
        // container stopped between BoxCompute's ensure and this command.
        const state = await this.state(sandbox);
        if (state === "missing") throw new Error("This sandbox does not exist on the runner; ensure it first.");
        if (state === "stopped") await this.must(dockerArgs.start(sandbox));
        current = this.touch(sandbox);
      }
      current.running += 1;
      return current;
    });
    if (signal.aborted) {
      entry.running -= 1;
      throw new Error("cancelled");
    }
    const execId = randomUUID();
    try {
      return await this.processes.stream(this.settings.command, dockerArgs.exec(sandbox, argv, execId), this.env, stdin, output, signal);
    } finally {
      entry.running -= 1;
      entry.lastActive = this.settings.now();
      entry.verifiedAt = entry.lastActive;
      if (signal.aborted) this.processes.detach(this.settings.command, dockerArgs.killExec(sandbox, execId), this.env);
    }
  }

  remove(sandbox: string): Promise<void> {
    return this.lock.run(sandbox, async () => {
      const container = await this.docker(dockerArgs.removeContainer(sandbox));
      if (container.code !== 0 && !/no such container/i.test(container.stderr)) {
        throw new Error(dockerError(container.stderr) || `docker rm exited with code ${container.code}`);
      }
      const volume = await this.docker(dockerArgs.removeVolume(sandbox));
      if (volume.code !== 0 && !/no such volume/i.test(volume.stderr)) {
        throw new Error(dockerError(volume.stderr) || `docker volume rm exited with code ${volume.code}`);
      }
      this.tracked.delete(sandbox);
    });
  }

  async sweep(): Promise<void> {
    if (!this.settings.idleStopMs || this.sweeping) return;
    this.sweeping = true;
    try {
      for (const [sandbox, entry] of this.tracked) {
        if (!this.idle(entry)) continue;
        await this.lock.run(sandbox, async () => {
          if (this.tracked.get(sandbox) !== entry || !this.idle(entry)) return;
          const result = await this.docker(dockerArgs.stop(sandbox));
          if (result.code === 0) {
            entry.stopped = true;
            this.settings.log(`idle-stop ${sandbox} after ${minutes(this.settings.idleStopMs)} without commands; files kept`);
          } else if (/no such container/i.test(result.stderr)) {
            this.tracked.delete(sandbox);
          } else {
            this.settings.log(`idle-stop ${sandbox} failed: ${dockerError(result.stderr) || `exit ${result.code}`}`);
          }
        }).catch((error: unknown) => {
          this.settings.log(`idle-stop ${sandbox} failed: ${(error as Error)?.message ?? String(error)}`);
        });
      }
    } finally {
      this.sweeping = false;
    }
  }

  shutdown(): Promise<void> {
    return this.processes.stop();
  }

  private idle(entry: Tracked): boolean {
    return !entry.stopped && entry.running === 0 && this.settings.now() - entry.lastActive >= this.settings.idleStopMs;
  }

  private touch(sandbox: string): Tracked {
    const entry = this.tracked.get(sandbox) ?? { lastActive: 0, verifiedAt: 0, running: 0, stopped: false };
    entry.lastActive = this.settings.now();
    entry.verifiedAt = entry.lastActive;
    entry.stopped = false;
    this.tracked.set(sandbox, entry);
    return entry;
  }

  private docker(args: string[]): Promise<Collected> {
    return this.processes.collect(this.settings.command, args, this.env);
  }

  private async must(args: string[]): Promise<void> {
    const result = await this.docker(args);
    if (result.code !== 0) throw new Error(dockerError(result.stderr) || `docker ${args[0]} exited with code ${result.code}`);
  }

  private async state(sandbox: string): Promise<"running" | "stopped" | "missing"> {
    const result = await this.docker(dockerArgs.inspect(sandbox));
    if (result.code === 0) return result.stdout.trim() === "true" ? "running" : "stopped";
    if (/no such (container|object)/i.test(result.stderr)) return "missing";
    throw new Error(dockerError(result.stderr) || `docker inspect exited with code ${result.code}`);
  }
}

function minutes(milliseconds: number): string {
  const total = Math.round(milliseconds / 60_000);
  if (total < 1) return `${Math.round(milliseconds / 1000)}s`;
  return total % 60 === 0 ? `${total / 60}h` : `${total}m`;
}

class CustomDispatcher implements Dispatcher {
  readonly mode = "custom" as const;
  private program = "";
  private readonly lock = new KeyedLock();

  constructor(
    private readonly requested: string,
    private readonly image: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly processes: Processes,
  ) {}

  async check(): Promise<void> {
    this.program = resolveProgram(this.requested, this.env);
  }

  ensure(sandbox: string, runnerId: string): Promise<void> {
    return this.lifecycle("ensure", sandbox, runnerId);
  }

  remove(sandbox: string, runnerId: string): Promise<void> {
    return this.lifecycle("delete", sandbox, runnerId);
  }

  exec(
    sandbox: string,
    runnerId: string,
    argv: string[],
    stdin: Buffer,
    output: OutputSink,
    signal: AbortSignal,
  ): Promise<number> {
    return this.processes.stream(this.program, argv, this.environment("exec", sandbox, runnerId), stdin, output, signal);
  }

  sweep(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.processes.stop();
  }

  private environment(operation: string, sandbox: string, runnerId: string): NodeJS.ProcessEnv {
    return {
      ...this.env,
      BOXCOMPUTE_OPERATION: operation,
      BOXCOMPUTE_SANDBOX_ID: sandbox,
      BOXCOMPUTE_RUNNER_ID: runnerId,
      BOXCOMPUTE_IMAGE: this.image,
    };
  }

  private lifecycle(operation: "ensure" | "delete", sandbox: string, runnerId: string): Promise<void> {
    return this.lock.run(sandbox, async () => {
      const result = await this.processes.collect(this.program, [], this.environment(operation, sandbox, runnerId));
      if (result.code !== 0) {
        throw new Error(lastLine(result.stderr) || `${path.basename(this.program)} ${operation} exited with code ${result.code}`);
      }
    });
  }
}
