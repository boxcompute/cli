import path from "node:path";
import type { Writable } from "node:stream";
import { createDispatcher, type Dispatcher, type OutputSink } from "./runner-dispatch.js";

export { RUNNER_TOKEN_ENV } from "./runner-dispatch.js";

export const DEFAULT_RUNNER_IMAGE = "node:22-bookworm";
export const DEFAULT_IDLE_STOP_MS = 30 * 60_000;
export const RUNNER_IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,254}$/;
export const RUNNER_TOKEN_PATTERN = /^bxr_[\x21-\x7e]+$/;

const PROTOCOL = 1;
const SANDBOX_ID = /^bxs-[a-f0-9]{16}$/;
const RUNNER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SOCKET_OPEN = 1;
// Output is queued in memory while the socket is slow; pause the command's
// pipes instead of letting several 64 MiB executions pile up.
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

const FATAL_CLOSES = new Map<number, string>([
  [4400, "BoxCompute rejected a message from this runner. Update the CLI with `bxc update`."],
  [4401, "BoxCompute did not accept BOXCOMPUTE_RUNNER_TOKEN. Create a runner in BoxCompute (Settings → Runners) and export its token."],
  [4403, "Self-hosted runners are not available on this BoxCompute account."],
  [4409, "Another `bxc runner` connected with the same token, so this one stopped."],
]);

export type RunnerTiming = {
  /** Drop the connection when nothing arrives for this long (the server pings every 25 s). */
  silenceMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  /** Reconnect window after close code 1012 (server restarting). */
  restartMinMs: number;
  restartMaxMs: number;
  sweepMs: number;
  closeWaitMs: number;
};

export type RunnerLimits = { maxConcurrent: number; outputBudget: number; outputChunk: number };

const DEFAULT_TIMING: RunnerTiming = {
  silenceMs: 70_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  restartMinMs: 1_000,
  restartMaxMs: 3_000,
  sweepMs: 60_000,
  closeWaitMs: 2_000,
};

const DEFAULT_LIMITS: RunnerLimits = {
  maxConcurrent: 8,
  outputBudget: 64 * 1024 * 1024,
  outputChunk: 256 * 1024,
};

export type RunnerOptions = {
  /** BoxCompute web origin, already normalized. */
  url: string;
  token: string;
  image: string;
  /** Whether --image was given; custom dispatch reports only a chosen image. */
  imageChosen: boolean;
  dispatch: string | null;
  idleStopMs: number;
  verbose: boolean;
  version: string;
};

export type RunnerDependencies = {
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
  signal: AbortSignal;
  WebSocket: typeof WebSocket;
  random?: () => number;
  now?: () => number;
  timing?: Partial<RunnerTiming>;
  limits?: Partial<RunnerLimits>;
};

type Frame = Record<string, unknown>;
type Operation = "ensure" | "exec" | "delete";
type Request = { id: string; op: Operation; sandbox: string; argv: string[]; stdin: Buffer };
type Welcome = { runnerId: string; name: string; maxConcurrent: number | null };
type Outcome =
  | { type: "stopped" }
  | { type: "fatal"; message: string }
  | { type: "retry"; code: number; welcomed: boolean; message: string };

/** The runner endpoint for a BoxCompute origin. Plain ws:// is only for loopback development servers. */
export function runnerSocketUrl(origin: string): string {
  const url = new URL(origin);
  if (url.protocol === "https:") return `wss://${url.host}/api/runners/connect`;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return `ws://${url.host}/api/runners/connect`;
  }
  throw new Error("bxc runner needs an https:// BoxCompute URL; plain http is allowed only for localhost.");
}

/** Parses --idle-stop: 0, or hours/minutes/seconds such as 30m, 2h or 1h30m. */
export function parseDuration(value: string): number {
  if (value === "0") return 0;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!value || !match) throw new Error("--idle-stop must be a duration such as 30m, 2h or 90s, or 0 to never stop");
  const [hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0)) as [number, number, number];
  const milliseconds = ((hours * 60 + minutes) * 60 + seconds) * 1000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("--idle-stop is too long");
  return milliseconds;
}

/** One printable line: no control characters, the token never, at most `limit` characters. */
export function safeText(value: string, limit: number, secret?: string): string {
  const text = (secret ? value.split(secret).join("[redacted]") : value)
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Validates a request frame. Returns nothing when there is no usable id to answer. */
export function parseRequest(frame: Frame): { id: string; request?: Request; error?: string } | undefined {
  const { id, op, sandbox, argv, stdin } = frame;
  if (typeof id !== "string" || !id || id.length > 200) return undefined;
  if (op !== "ensure" && op !== "exec" && op !== "delete") return { id, error: "unsupported operation" };
  if (typeof sandbox !== "string" || !SANDBOX_ID.test(sandbox)) return { id, error: "invalid sandbox id" };
  if (op !== "exec") return { id, request: { id, op, sandbox, argv: [], stdin: Buffer.alloc(0) } };
  if (!Array.isArray(argv) || !argv.length || !argv.every((arg) => typeof arg === "string" && !arg.includes("\0"))) {
    return { id, error: "invalid argv" };
  }
  if (stdin !== undefined && stdin !== null && (typeof stdin !== "string" || stdin.length % 4 !== 0 || !BASE64.test(stdin))) {
    return { id, error: "invalid stdin" };
  }
  return {
    id,
    request: {
      id,
      op,
      sandbox,
      argv: argv as string[],
      stdin: typeof stdin === "string" ? Buffer.from(stdin, "base64") : Buffer.alloc(0),
    },
  };
}

function parseFrame(data: unknown): Frame | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Frame : undefined;
  } catch {
    return undefined;
  }
}

function parseWelcome(frame: Frame): Welcome | undefined {
  const { runnerId, name, maxConcurrent } = frame;
  if (typeof runnerId !== "string" || !RUNNER_ID.test(runnerId)) return undefined;
  return {
    runnerId,
    name: typeof name === "string" && name.trim() ? name : runnerId,
    maxConcurrent: Number.isSafeInteger(maxConcurrent) && Number(maxConcurrent) > 0 ? Number(maxConcurrent) : null,
  };
}

function closeQuietly(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closing.
  }
}

const elapsed = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)}s`;

type Link = { send(frame: Frame): void; drained(): Promise<void> | undefined };
type SessionContext = {
  link: Link;
  dispatcher: Dispatcher;
  runnerId: string;
  limit: number;
  limits: RunnerLimits;
  token: string;
  verbose: boolean;
  now: () => number;
  log: (line: string) => void;
};
type Active = { request: Request; controller: AbortController; replied: boolean; started: number };

/** Requests on one welcomed connection. A reconnect starts a new session; the server already failed the old one's requests. */
class Session {
  private readonly queue: Request[] = [];
  private readonly active = new Map<string, Active>();
  private closed = false;

  constructor(private readonly context: SessionContext) {}

  handle(frame: Frame): void {
    if (frame.type === "request") this.request(frame);
    else if (frame.type === "cancel") this.cancel(frame.id);
    // Unknown frame types are ignored so the server can add new ones.
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    for (const active of this.active.values()) active.controller.abort();
  }

  private request(frame: Frame): void {
    const parsed = parseRequest(frame);
    if (!parsed) return;
    // A repeated id would make two results ambiguous; the first request answers it.
    if (this.active.has(parsed.id) || this.queue.some((request) => request.id === parsed.id)) return;
    if (!parsed.request) {
      this.reply(parsed.id, { ok: false, error: parsed.error });
      this.context.log(`${safeText(String(frame.op), 20) || "request"} rejected: ${parsed.error}`);
      return;
    }
    this.queue.push(parsed.request);
    this.pump();
  }

  private cancel(id: unknown): void {
    if (typeof id !== "string") return;
    const index = this.queue.findIndex((request) => request.id === id);
    if (index >= 0) {
      const [request] = this.queue.splice(index, 1);
      this.reply(id, { ok: false, error: "cancelled" });
      this.finished(request!, this.context.now(), "cancelled before it started");
      return;
    }
    const active = this.active.get(id);
    if (!active || active.replied) return;
    active.controller.abort();
    active.replied = true;
    this.reply(id, { ok: false, error: "cancelled" });
    this.finished(active.request, active.started, "cancelled");
  }

  private pump(): void {
    while (!this.closed && this.active.size < this.context.limit && this.queue.length) {
      void this.run(this.queue.shift()!);
    }
  }

  private async run(request: Request): Promise<void> {
    const { dispatcher, runnerId } = this.context;
    const active: Active = { request, controller: new AbortController(), replied: false, started: this.context.now() };
    this.active.set(request.id, active);
    let result: Frame;
    let status: string;
    try {
      if (request.op === "exec") {
        const exitCode = await dispatcher.exec(
          request.sandbox, runnerId, request.argv, request.stdin, this.sink(active), active.controller.signal,
        );
        result = { ok: true, exitCode };
        status = `exit ${exitCode}`;
      } else {
        await (request.op === "ensure" ? dispatcher.ensure(request.sandbox, runnerId) : dispatcher.remove(request.sandbox, runnerId));
        result = { ok: true };
        status = "ok";
      }
    } catch (error) {
      const message = safeText((error as Error)?.message ?? String(error), 500, this.context.token) || "operation failed";
      result = { ok: false, error: message };
      status = `failed: ${message}`;
    } finally {
      this.active.delete(request.id);
    }
    if (!active.replied) {
      active.replied = true;
      if (this.closed) {
        this.finished(request, active.started, "interrupted");
      } else {
        this.reply(request.id, result);
        this.finished(request, active.started, status);
      }
    }
    this.pump();
  }

  private sink(active: Active): OutputSink {
    const { limits, link } = this.context;
    let forwarded = 0;
    let truncated = false;
    return (stream, chunk) => {
      if (active.replied || this.closed) return undefined;
      const room = limits.outputBudget - forwarded;
      if (chunk.length > room && !truncated) {
        truncated = true;
        this.context.log(
          `exec ${active.request.sandbox} output passed ${Math.round(limits.outputBudget / 1024 / 1024)} MiB; discarding the rest`,
        );
      }
      if (room <= 0) return undefined;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      forwarded += part.length;
      for (let offset = 0; offset < part.length; offset += limits.outputChunk) {
        link.send({
          type: "output",
          id: active.request.id,
          stream,
          data: part.subarray(offset, offset + limits.outputChunk).toString("base64"),
        });
      }
      return link.drained();
    };
  }

  private reply(id: string, result: Frame): void {
    this.context.link.send({ type: "result", id, ...result });
  }

  private finished(request: Request, started: number, status: string): void {
    let line = `${request.op} ${request.sandbox} ${status} (${elapsed(this.context.now() - started)})`;
    if (this.context.verbose && request.op === "exec") line += ` ${safeText(JSON.stringify(request.argv), 1000, this.context.token)}`;
    this.context.log(line);
  }
}

function pause(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const done = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve(true);
    }, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Keeps an outbound WebSocket to BoxCompute open and runs the agent's
 * operations through the dispatcher. Resolves 0 after a signal and 1 when
 * BoxCompute refuses this runner; transient failures reconnect.
 */
export async function runRunner(options: RunnerOptions, deps: RunnerDependencies): Promise<number> {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const out = (line: string) => { deps.stdout.write(`${line}\n`); };
  const err = (line: string) => { deps.stderr.write(`${line}\n`); };
  const socketUrl = runnerSocketUrl(options.url);
  const host = new URL(socketUrl).host;
  const dispatcher = createDispatcher({
    program: options.dispatch,
    image: options.image,
    idleStopMs: options.idleStopMs,
    env: deps.env,
    log: out,
  });
  await dispatcher.check();
  const purpose = dispatcher.mode === "docker"
    ? "Chats that run on this runner will start containers here."
    : `Chats that run on this runner will run commands through ${path.basename(options.dispatch ?? "")}.`;
  let connectedBefore = false;
  const hello = {
    type: "hello",
    protocol: PROTOCOL,
    token: options.token,
    client: {
      name: "bxc",
      version: options.version,
      platform: process.platform,
      arch: process.arch,
      dispatch: dispatcher.mode,
      image: dispatcher.mode === "docker" || options.imageChosen ? options.image : null,
    },
  };

  const connectOnce = () => new Promise<Outcome>((resolve) => {
    let socket: WebSocket;
    try {
      socket = new deps.WebSocket(socketUrl);
    } catch {
      resolve({ type: "retry", code: 0, welcomed: false, message: `Could not connect to ${host}.` });
      return;
    }
    let opened = false;
    let stopping = false;
    let settled = false;
    let session: Session | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    let stopTimer: NodeJS.Timeout | undefined;

    const link: Link = {
      send(frame) {
        if (socket.readyState !== SOCKET_OPEN) return;
        try {
          socket.send(JSON.stringify(frame));
        } catch {
          // The close event reports the failure.
        }
      },
      drained() {
        if (socket.readyState !== SOCKET_OPEN || socket.bufferedAmount <= HIGH_WATER) return undefined;
        return new Promise<void>((resolveDrain) => {
          const check = () => {
            if (settled || socket.readyState !== SOCKET_OPEN || socket.bufferedAmount <= LOW_WATER) resolveDrain();
            else setTimeout(check, 20);
          };
          setTimeout(check, 20);
        });
      },
    };
    const finish = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(stopTimer);
      deps.signal.removeEventListener("abort", stop);
      session?.close();
      resolve(outcome);
    };
    const silent = () => {
      finish(opened
        ? { type: "retry", code: 0, welcomed: Boolean(session), message: `No message from BoxCompute for ${Math.round(timing.silenceMs / 1000)}s.` }
        : { type: "retry", code: 0, welcomed: false, message: `Could not connect to ${host}.` });
      closeQuietly(socket, 1000, "no ping");
    };
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(silent, timing.silenceMs);
    };
    function stop() {
      stopping = true;
      session?.close();
      closeQuietly(socket, 1000, "runner stopped");
      stopTimer = setTimeout(() => finish({ type: "stopped" }), timing.closeWaitMs);
    }

    socket.addEventListener("open", () => {
      opened = true;
      arm();
      link.send(hello);
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (settled || stopping) return;
      arm();
      const frame = parseFrame(event.data);
      if (!frame) return;
      if (frame.type === "ping") {
        link.send({ type: "pong", t: frame.t });
        return;
      }
      if (session) {
        session.handle(frame);
        return;
      }
      if (frame.type === "welcome") {
        const welcome = parseWelcome(frame);
        if (!welcome) {
          finish({ type: "fatal", message: "BoxCompute sent a welcome this CLI does not understand. Update it with `bxc update`." });
          closeQuietly(socket, 1000, "invalid welcome");
          return;
        }
        session = new Session({
          link,
          dispatcher,
          runnerId: welcome.runnerId,
          limit: Math.min(limits.maxConcurrent, welcome.maxConcurrent ?? limits.maxConcurrent),
          limits,
          token: options.token,
          verbose: options.verbose,
          now,
          log: out,
        });
        const name = safeText(welcome.name, 100, options.token);
        out(connectedBefore ? `Reconnected as "${name}".` : `Connected as "${name}". ${purpose} Press Ctrl-C to stop.`);
        connectedBefore = true;
        return;
      }
      if (frame.type === "request" && typeof frame.id === "string") {
        link.send({ type: "result", id: frame.id, ok: false, error: "runner is not ready" });
      }
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      if (stopping) {
        finish({ type: "stopped" });
        return;
      }
      const reason = safeText(String(event.reason ?? ""), 200, options.token);
      const detail = `${event.code}${reason ? `: ${reason}` : ""}`;
      const fatal = FATAL_CLOSES.get(event.code);
      if (fatal) finish({ type: "fatal", message: `${fatal} (${detail})` });
      else if (!opened) finish({ type: "retry", code: event.code, welcomed: false, message: `Could not connect to ${host}.` });
      else if (event.code === 1012) finish({ type: "retry", code: 1012, welcomed: Boolean(session), message: "BoxCompute is restarting." });
      else finish({ type: "retry", code: event.code, welcomed: Boolean(session), message: `Disconnected (${detail}).` });
    });
    socket.addEventListener("error", () => undefined);
    arm();
    if (deps.signal.aborted) stop();
    else deps.signal.addEventListener("abort", stop, { once: true });
  });

  const sweep = dispatcher.mode === "docker" && options.idleStopMs > 0
    ? setInterval(() => { void dispatcher.sweep(); }, timing.sweepMs)
    : undefined;
  try {
    let backoff = timing.backoffMinMs;
    for (;;) {
      if (deps.signal.aborted) break;
      if (options.verbose) err(`Connecting to ${socketUrl}`);
      const outcome = await connectOnce();
      if (outcome.type === "stopped") break;
      if (outcome.type === "fatal") {
        err(outcome.message);
        return 1;
      }
      if (outcome.welcomed) backoff = timing.backoffMinMs;
      let wait: number;
      if (outcome.code === 1012) {
        wait = timing.restartMinMs + random() * (timing.restartMaxMs - timing.restartMinMs);
      } else {
        wait = Math.min(timing.backoffMaxMs, Math.max(timing.backoffMinMs, backoff * (0.75 + random() * 0.5)));
        backoff = Math.min(backoff * 2, timing.backoffMaxMs);
      }
      err(`${outcome.message} Reconnecting in ${Math.max(1, Math.round(wait / 1000))}s.`);
      if (!await pause(wait, deps.signal)) break;
    }
    out(dispatcher.mode === "docker" ? "Runner stopped. Containers and their files stay on this machine." : "Runner stopped.");
    return 0;
  } finally {
    clearInterval(sweep);
    await dispatcher.shutdown();
  }
}
