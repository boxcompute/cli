import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type Connection = { url: string; token: string; tokenFile: string };

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BoxCompute URL must be an absolute http or https URL");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("BoxCompute URL must be an http or https origin without credentials");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("BoxCompute URL must be an origin without a path, query, or fragment");
  }
  return url.origin;
}

export function connectionPaths(env: NodeJS.ProcessEnv = process.env) {
  const directory = env.BOXCOMPUTE_CONFIG_DIR
    ? path.resolve(env.BOXCOMPUTE_CONFIG_DIR)
    : path.join(env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : homedir(), "boxcompute");
  return {
    directory,
    configFile: path.join(directory, "config.json"),
    tokenFile: path.join(directory, "credential"),
  };
}

async function secureFile(file: string): Promise<void> {
  const mode = (await stat(file)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${file} must not be readable by group or other users (run chmod 600)`);
  }
}

export async function loadConnection(env: NodeJS.ProcessEnv = process.env): Promise<Connection> {
  const paths = connectionPaths(env);
  let url = env.BOXCOMPUTE_URL;
  let tokenFile = env.BOXCOMPUTE_TOKEN_FILE;
  if (!url || !tokenFile) {
    let parsed: { url?: unknown; tokenFile?: unknown };
    try {
      parsed = JSON.parse(await readFile(paths.configFile, "utf8")) as typeof parsed;
    } catch {
      throw new Error("Not authenticated. Run `bxc auth` first.");
    }
    url ??= typeof parsed.url === "string" ? parsed.url : undefined;
    tokenFile ??= typeof parsed.tokenFile === "string" ? parsed.tokenFile : undefined;
  }
  if (!url || !tokenFile) throw new Error("Not authenticated. Run `bxc auth` first.");
  const resolvedTokenFile = path.resolve(tokenFile);
  await secureFile(resolvedTokenFile);
  const token = (await readFile(resolvedTokenFile, "utf8")).trim();
  if (!token.startsWith("bc_live_")) throw new Error("The saved BoxCompute credential is invalid. Run `bxc auth` again.");
  return { url: normalizeBaseUrl(url), token, tokenFile: resolvedTokenFile };
}

export async function loadSavedUrl(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.BOXCOMPUTE_URL) return normalizeBaseUrl(env.BOXCOMPUTE_URL);
  try {
    const parsed = JSON.parse(await readFile(connectionPaths(env).configFile, "utf8")) as { url?: unknown };
    return typeof parsed.url === "string" ? normalizeBaseUrl(parsed.url) : null;
  } catch {
    return null;
  }
}

export async function saveConnection(url: string, token: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!token.startsWith("bc_live_")) throw new Error("BoxCompute returned an invalid credential");
  const paths = connectionPaths(env);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const suffix = randomUUID();
  const tokenTemp = `${paths.tokenFile}.${suffix}.tmp`;
  const configTemp = `${paths.configFile}.${suffix}.tmp`;
  try {
    await writeFile(tokenTemp, `${token}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(configTemp, `${JSON.stringify({ url: normalizeBaseUrl(url), tokenFile: paths.tokenFile }, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(tokenTemp, paths.tokenFile);
    await chmod(paths.tokenFile, 0o600);
    await rename(configTemp, paths.configFile);
    await chmod(paths.configFile, 0o600);
  } finally {
    await rm(tokenTemp, { force: true }).catch(() => undefined);
    await rm(configTemp, { force: true }).catch(() => undefined);
  }
}

export async function clearConnection(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const paths = connectionPaths(env);
  await rm(paths.tokenFile, { force: true });
  await rm(paths.configFile, { force: true });
}
