import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import { browserLaunch, openBrowser, runCli } from "../src/cli.js";

function streams() {
  return { stdout: new PassThrough(), stderr: new PassThrough() };
}

function output(stream: PassThrough): string {
  let value = "";
  let chunk: Buffer | null;
  while ((chunk = stream.read() as Buffer | null) !== null) value += chunk.toString();
  return value;
}

describe("bxc CLI", () => {
  it("updates to a newer npm release without requiring authentication", async () => {
    const io = streams();
    const installed: string[] = [];
    expect(await runCli(["up"], {
      io,
      env: {},
      fetch: (async (input: string | URL | Request) => {
        expect(String(input)).toBe("https://registry.npmjs.org/%40boxcompute%2Fcli/latest");
        return new Response(JSON.stringify({ version: "99.0.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof globalThis.fetch,
      installUpdate: async (version) => { installed.push(version); },
      loadConnection: async () => { throw new Error("should not authenticate"); },
    })).toBe(0);

    expect(installed).toEqual(["99.0.0"]);
    expect(output(io.stderr)).toContain("Updating BoxCompute CLI");
    expect(output(io.stdout)).toContain("Updated BoxCompute CLI to 99.0.0");
  });

  it("does not reinstall or downgrade an up-to-date CLI", async () => {
    const io = streams();
    expect(await runCli(["update"], {
      io,
      env: {},
      fetch: (async () => new Response(JSON.stringify({ version: "0.0.1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch,
      installUpdate: async () => { throw new Error("should not install"); },
    })).toBe(0);
    expect(output(io.stdout)).toContain("already up to date");
  });

  it("opens browser authentication through Windows from WSL", () => {
    expect(browserLaunch("https://app.boxcompute.ai/cli-auth?code=ABCD-EFGH", {
      system: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      kernelRelease: "5.15.153.1-microsoft-standard-WSL2",
    })).toEqual({
      command: "explorer.exe",
      args: ["https://app.boxcompute.ai/cli-auth?code=ABCD-EFGH"],
      detached: false,
    });
  });

  it("keeps the native browser launchers outside WSL", () => {
    const url = "https://app.boxcompute.ai/cli-auth?code=ABCD-EFGH";
    expect(browserLaunch(url, {
      system: "linux",
      env: {},
      kernelRelease: "6.12.0-generic",
    })).toEqual({ command: "xdg-open", args: [url], detached: true });
    expect(browserLaunch(url, {
      system: "darwin",
      env: {},
      kernelRelease: "24.6.0",
    })).toEqual({ command: "open", args: [url], detached: true });
  });

  it("keeps login usable when the browser process cannot be spawned", () => {
    const spawnError = Object.assign(new Error("spawn EIO"), { code: "EIO" });
    expect(() => openBrowser("https://app.boxcompute.ai/cli-auth?code=ABCD-EFGH", {
      system: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      kernelRelease: "5.15.153.1-microsoft-standard-WSL2",
      spawn: (() => { throw spawnError; }) as unknown as typeof import("node:child_process").spawn,
    })).not.toThrow();
  });

  it("authenticates through browser device approval without printing the credential", async () => {
    const io = streams();
    const opened: string[] = [];
    const saved: Array<{ url: string; token: string }> = [];
    let polls = 0;
    let clock = 0;
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/cli-auth/device")) return new Response(JSON.stringify({
        deviceCode: `bcd_${"a".repeat(43)}`,
        userCode: "ABCD-EFGH",
        verificationUri: "https://app.boxcompute.ai/cli-auth",
        verificationUriComplete: "https://app.boxcompute.ai/cli-auth?code=ABCD-EFGH",
        expiresIn: 600,
        interval: 2,
      }), { status: 201, headers: { "content-type": "application/json" } });
      polls += 1;
      if (polls === 1) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 428, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ token: "bc_live_browser_issued" }), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;

    expect(await runCli(["login", "--url", "https://app.boxcompute.ai"], {
      io,
      env: {},
      fetch,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      openBrowser: (url) => opened.push(url),
      loadSavedUrl: async () => null,
      saveConnection: async (url, token) => { saved.push({ url, token }); },
    })).toBe(0);

    expect(opened).toEqual(["https://app.boxcompute.ai/cli-auth?code=ABCD-EFGH"]);
    expect(saved).toEqual([{ url: "https://app.boxcompute.ai", token: "bc_live_browser_issued" }]);
    expect(`${output(io.stdout)}${output(io.stderr)}`).not.toContain("bc_live_browser_issued");
    expect(polls).toBe(2);
  });

  it("explains when the selected server has not deployed browser login", async () => {
    await expect(runCli(["login"], {
      io: streams(),
      env: {},
      fetch: (async () => new Response(JSON.stringify({ error: "unauthenticated" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch,
      loadSavedUrl: async () => null,
    })).rejects.toThrow(
      "Browser login is not available at https://app.boxcompute.ai (HTTP 401)",
    );
  });

  it("requires explicit confirmation before destroying a runtime", async () => {
    const connection = { url: "https://app.boxcompute.ai", token: "bc_live_test", tokenFile: "/credential" };
    await expect(runCli(["sandbox", "delete", "workspace-one"], {
      io: streams(),
      env: {},
      loadConnection: async () => connection,
    })).rejects.toThrow("--yes");
  });

  it("lists parent workspaces before the first sandbox is created", async () => {
    const io = streams();
    const connection = { url: "https://app.boxcompute.ai", token: "bc_live_test", tokenFile: "/credential" };
    expect(await runCli(["workspaces"], {
      io,
      env: {},
      loadConnection: async () => connection,
      fetch: (async () => new Response(JSON.stringify({
        workspaces: [{ id: "workspace-one", name: "Demo", createdAt: 1 }],
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch,
    })).toBe(0);
    expect(output(io.stdout)).toBe("workspace-one\tDemo\n");
  });

  it("reads retained sandbox logs with filters without starting compute", async () => {
    const io = streams();
    const connection = { url: "https://app.boxcompute.ai", token: "bc_live_test", tokenFile: "/credential" };
    let requested = "";
    let method: string | undefined;
    expect(await runCli([
      "sandbox", "logs", "sandbox-one",
      "--since", "2026-09-01T00:00:00Z",
      "--until", "2026-09-07T00:00:00Z",
      "--stream", "stderr",
      "--source", "process",
      "--limit", "25",
    ], {
      io,
      env: {},
      loadConnection: async () => connection,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        requested = String(input);
        method = init?.method;
        return new Response(JSON.stringify({ logs: {
          sandbox_id: "runtime-one",
          entries: [{
            timestamp: "2026-09-06T01:02:03.000Z",
            stream: "stderr",
            source: "process",
            message: "database ready",
            pod_uid: "pod-one",
            process_id: "proc-one",
          }],
          truncated: false,
          retention_seconds: 2_592_000,
        } }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof globalThis.fetch,
    })).toBe(0);

    expect(method).toBeUndefined();
    expect(requested).toContain("/api/v2/sandboxes/sandbox-one/logs?");
    expect(requested).toContain("since=2026-09-01T00%3A00%3A00.000Z");
    expect(requested).toContain("until=2026-09-07T00%3A00%3A00.000Z");
    expect(requested).toContain("stream=stderr");
    expect(requested).toContain("source=process");
    expect(requested).toContain("limit=25");
    expect(output(io.stdout)).toContain("database ready");
    expect(output(io.stderr)).toContain("retentionSeconds=2592000");
  });

  it("passes CLI-looking program arguments through the exec boundary", async () => {
    const io = streams();
    const connection = { url: "https://app.boxcompute.ai", token: "bc_live_test", tokenFile: "/credential" };
    let body: unknown;
    expect(await runCli([
      "--json", "sandbox", "exec", "sandbox-one", "--", "python", "--version", "--json",
    ], {
      io,
      env: {},
      loadConnection: async () => connection,
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ result: {
          stdout: "Python 3.14.4\n",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          wallTimeSeconds: 0.01,
        } }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof globalThis.fetch,
    })).toBe(0);

    expect(body).toEqual({ argv: ["python", "--version", "--json"] });
    expect(JSON.parse(output(io.stdout))).toMatchObject({
      sandboxId: "sandbox-one",
      stdout: "Python 3.14.4\n",
    });
  });

  it("dispatches experimental SSH only after explicit opt-in", async () => {
    const connection = { url: "https://app.boxcompute.ai", token: "bc_live_test", tokenFile: "/credential" };
    const invoked: Array<{ id: string; action: unknown }> = [];
    expect(await runCli(["sandbox", "ssh", "sbx_demo", "--reconnect"], {
      io: streams(),
      env: { BOXCOMPUTE_ENABLE_SSH: "1" },
      loadConnection: async () => connection,
      ssh: async (id, action) => {
        invoked.push({ id, action });
        return 0;
      },
    })).toBe(0);
    expect(invoked).toEqual([{ id: "sbx_demo", action: { reconnect: true, revoke: undefined } }]);

    await expect(runCli(["sandbox", "ssh", "sbx_demo"], {
      io: streams(),
      env: {},
      loadConnection: async () => connection,
      ssh: async () => 0,
    })).rejects.toThrow("BOXCOMPUTE_ENABLE_SSH=1");
  });

  it("runs the private proxy helper without loading API credentials", async () => {
    const invoked: string[] = [];
    expect(await runCli(["proxy", "/private/config.json"], {
      io: streams(),
      env: {},
      loadConnection: async () => { throw new Error("should not authenticate"); },
      proxy: async (path) => {
        invoked.push(path);
        return 0;
      },
    })).toBe(0);
    expect(invoked).toEqual(["/private/config.json"]);
  });

  it("rejects invalid sandbox log filters before calling the server", async () => {
    await expect(runCli(["sandbox", "logs", "sandbox-one", "--stream", "both"], {
      io: streams(),
      env: {},
      loadConnection: async () => ({
        url: "https://app.boxcompute.ai",
        token: "bc_live_test",
        tokenFile: "/credential",
      }),
      fetch: (async () => { throw new Error("should not fetch"); }) as unknown as typeof globalThis.fetch,
    })).rejects.toThrow("--stream must be one of: stdout, stderr");
  });

  it("refreshes managed skills on normal commands without requiring a second command", async () => {
    const io = streams();
    expect(await runCli(["sandbox"], {
      io,
      env: {},
      syncManagedSkills: async () => [{
        agents: ["Codex"],
        path: "/test/.codex/skills/boxcompute-sandbox",
        status: "updated",
      }],
    })).toBe(0);
    expect(output(io.stderr)).toContain("Updated the BoxCompute skill for Codex");
    expect(output(io.stdout)).toContain("Usage: bxc sandbox");
  });

  it("shows detected coding harnesses without requiring authentication", async () => {
    const io = streams();
    expect(await runCli(["skill", "detect"], {
      io,
      env: {},
      detectHarnesses: async () => [{
        id: "opencode",
        label: "OpenCode",
        detected: true,
        signals: ["command:opencode"],
        path: "/home/test/.config/opencode/skills/boxcompute-sandbox",
        installed: false,
      }],
      loadConnection: async () => { throw new Error("should not authenticate"); },
    })).toBe(0);
    expect(output(io.stdout)).toContain("OpenCode");
  });

  it("requires confirmation before removing skills", async () => {
    const io = streams();
    await expect(runCli(["skill", "remove", "opencode"], {
      io,
      env: {},
      removeSkill: async () => { throw new Error("should not remove"); },
    })).rejects.toThrow("--yes");

    expect(await runCli(["skill", "uninstall", "opencode", "--yes"], {
      io,
      env: {},
      removeSkill: async () => [{
        agents: ["OpenCode"],
        path: "/home/test/.config/opencode/skills/boxcompute-sandbox",
        status: "removed",
      }],
    })).toBe(0);
    expect(output(io.stdout)).toContain("Removed for OpenCode");
  });

  it("prints hierarchical help and version without authenticating", async () => {
    const io = streams();
    expect(await runCli(["skill", "--help"], { io, env: {} })).toBe(0);
    expect(output(io.stdout)).toContain("Usage: bxc skill <command> [options]");

    const versionIo = streams();
    expect(await runCli(["--version"], { io: versionIo, env: {} })).toBe(0);
    expect(output(versionIo.stdout)).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});
