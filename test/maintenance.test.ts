import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "bun:test";
import { runCli } from "../src/cli.js";
import { fetchMaintenanceNotice, type MaintenanceNotice } from "../src/maintenance.js";

const roots: string[] = [];
const notice = {
  id: "core-host-2026-10-20",
  revision: 1,
  kind: "planned",
  status: "scheduled",
  startsAt: "2026-10-20T01:00:00Z",
  endsAt: "2026-10-20T02:30:00Z",
  impact: "Running Sandboxes may sleep and reconnect. Files are preserved.",
} as const;

const streams = () => ({ stdout: new PassThrough(), stderr: new PassThrough() });
function output(stream: PassThrough): string {
  let value = "", chunk: Buffer | null;
  while ((chunk = stream.read() as Buffer | null) !== null) value += chunk.toString();
  return value;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "bxc-maintenance-"));
  roots.push(root);
  return { BOXCOMPUTE_CONFIG_DIR: root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("maintenance notice", () => {
  it("prints an interactive MOTD once per local day and reappears for a new revision", async () => {
    const env = await fixture();
    let active: MaintenanceNotice = notice;
    const fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/meta") return Response.json({ maintenance: active });
      if (url.pathname === "/api/v2/sandboxes") return Response.json({ sandboxes: [] });
      throw new Error(`unexpected ${url}`);
    }) as typeof globalThis.fetch;
    const run = async (now: number) => {
      const io = streams();
      expect(await runCli(["sandboxes"], {
        io, env, fetch, now: () => now, interactive: true,
        syncManagedSkills: async () => [],
        loadConnection: async () => ({ url: "https://app.boxcompute.ai", token: "bc_live_test", tokenFile: "/credential" }),
      })).toBe(0);
      return output(io.stderr);
    };

    const day = Date.parse("2026-10-15T09:00:00Z");
    expect(await run(day)).toContain("PLANNED MAINTENANCE · Scheduled");
    expect(await run(day + 60_000)).toBe("");
    expect(await run(day + 86_400_000)).toContain("PLANNED MAINTENANCE");
    active = { ...notice, revision: 2, kind: "urgent", status: "in_progress" };
    expect(await run(day + 86_400_001)).toContain("URGENT MAINTENANCE · In progress");

    const state = path.join(env.BOXCOMPUTE_CONFIG_DIR, "maintenance-notices.json");
    expect((await stat(state)).mode & 0o777).toBe(0o600);
    expect(await readFile(state, "utf8")).not.toContain(active.impact);
  });

  it("dismisses one revision, shows a changed revision, and keeps JSON output clean", async () => {
    const env = await fixture();
    let active: MaintenanceNotice = notice;
    const fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/meta") return Response.json({ maintenance: active });
      if (url.pathname === "/api/v2/sandboxes") return Response.json({ sandboxes: [] });
      throw new Error(`unexpected ${url}`);
    }) as typeof globalThis.fetch;
    const shared = {
      env, fetch, now: () => Date.parse("2026-10-15T09:00:00Z"), interactive: true,
      syncManagedSkills: async () => [],
      loadConnection: async () => ({ url: "https://app.boxcompute.ai", token: "bc_live_test", tokenFile: "/credential" }),
      loadSavedUrl: async () => "https://app.boxcompute.ai",
    };
    const dismissed = streams();
    expect(await runCli(["maintenance", "dismiss"], { ...shared, io: dismissed })).toBe(0);
    expect(output(dismissed.stdout)).toContain("Dismissed maintenance notice");

    const hidden = streams();
    expect(await runCli(["sandboxes"], { ...shared, io: hidden })).toBe(0);
    expect(output(hidden.stderr)).toBe("");
    active = { ...notice, revision: 2 };
    const changed = streams();
    expect(await runCli(["sandboxes"], { ...shared, io: changed })).toBe(0);
    expect(output(changed.stderr)).toContain("PLANNED MAINTENANCE");

    const json = streams();
    expect(await runCli(["--json", "sandboxes"], { ...shared, io: json })).toBe(0);
    expect(output(json.stderr)).toBe("");
    expect(JSON.parse(output(json.stdout))).toEqual({ sandboxes: [] });
  });

  it("never blocks a command when the optional MOTD request fails", async () => {
    const io = streams();
    expect(await runCli(["sandboxes"], {
      io, env: await fixture(), interactive: true, syncManagedSkills: async () => [],
      loadConnection: async () => ({ url: "https://app.boxcompute.ai", token: "bc_live_test", tokenFile: "/credential" }),
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/meta") throw new Error("offline");
        return Response.json({ sandboxes: [] });
      }) as typeof globalThis.fetch,
    })).toBe(0);
    expect(output(io.stdout)).toContain("No sandboxes found");
    expect(output(io.stderr)).toBe("");
  });

  it("rejects notices outside the strict public contract", async () => {
    for (const maintenance of [
      { ...notice, impact: "Sandboxes may restart.\u001b[2J" },
      { ...notice, startsAt: "2026-10-20 01:00:00Z" },
      { ...notice, extra: "unreviewed customer copy" },
    ]) {
      const fetch = (async (_input: string | URL | Request) =>
        Response.json({ maintenance })) as typeof globalThis.fetch;
      await expect(fetchMaintenanceNotice("https://app.boxcompute.ai", fetch)).rejects.toThrow(
        "invalid maintenance notice",
      );
    }
  });
});
