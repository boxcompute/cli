import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearConnection, connectionPaths, loadConnection, saveConnection } from "../src/config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local connection storage", () => {
  it("stores the credential separately with restrictive permissions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bcompute-config-"));
    directories.push(directory);
    const env = { BOXCOMPUTE_CONFIG_DIR: directory };
    await saveConnection("https://app.boxcompute.ai/", "bc_live_test", env);
    const paths = connectionPaths(env);

    expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.tokenFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.configFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(paths.configFile, "utf8")).not.toContain("bc_live_test");
    expect(await loadConnection(env)).toEqual({
      url: "https://app.boxcompute.ai",
      token: "bc_live_test",
      tokenFile: paths.tokenFile,
    });

    await clearConnection(env);
    expect(loadConnection(env)).rejects.toThrow("bxc auth");
  });
});
