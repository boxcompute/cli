import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CliIo } from "./ssh.js";

export async function runProxy(configPath: string, io: CliIo): Promise<number> {
  if (!["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("Connection proxy requires Linux or macOS on x64 or arm64");
  }
  const binary = fileURLToPath(new URL(`./native/boxcompute-proxy-${process.platform}-${process.arch}`, import.meta.url));
  return new Promise<number>((resolve) => {
    const child = spawn(binary, ["proxy", configPath], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    });
    let killTimer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;
    let stopped = false;
    let closed = false;
    const stop = () => {
      if (stopped || closed) return;
      stopped = true;
      clearTimeout(stallTimer);
      io.stdin.unpipe(child.stdin);
      child.stdout.unpipe(io.stdout);
      child.stdin.destroy();
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    child.stdout.on("pause", () => {
      if (stopped || closed) return;
      stallTimer ??= setTimeout(stop, 10_000);
      stallTimer.unref();
    });
    child.stdout.on("resume", () => {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);
    io.stdin.on("error", stop);
    io.stdout.on("error", stop);
    io.stdout.on("close", stop);
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    io.stdin.pipe(child.stdin);
    child.stdout.pipe(io.stdout, { end: false });
    child.on("error", () => undefined);
    child.on("close", (code) => {
      closed = true;
      clearTimeout(killTimer);
      clearTimeout(stallTimer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
      io.stdin.off("error", stop);
      io.stdout.off("error", stop);
      io.stdout.off("close", stop);
      io.stdin.unpipe(child.stdin);
      child.stdout.unpipe(io.stdout);
      if (code !== 0 || stopped) io.stderr.write("Connection proxy unavailable\n");
      resolve(code === 0 && !stopped ? 0 : 1);
    });
  });
}
