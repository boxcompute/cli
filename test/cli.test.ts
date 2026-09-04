import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import { runCli } from "../src/cli.js";

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
