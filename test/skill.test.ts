import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectHarnesses, installSkill, removeSkill, syncManagedSkills } from "../src/skill.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "bcompute-harnesses-"));
  directories.push(directory);
  return directory;
}

async function contentDigest(directory: string): Promise<string> {
  const digest = createHash("sha256");
  const walk = async (current: string, prefix = "") => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      if (relative === ".boxcompute-managed.json") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else {
        digest.update(relative);
        digest.update("\0");
        digest.update(await readFile(absolute));
        digest.update("\0");
      }
    }
  };
  await walk(directory);
  return digest.digest("hex");
}

describe("coding harness skill installation", () => {
  it("detects only known config roots without recursively scanning home", async () => {
    const directory = await home();
    await mkdir(path.join(directory, ".config", "opencode"), { recursive: true });
    await mkdir(path.join(directory, ".gemini"), { recursive: true });
    await mkdir(path.join(directory, "unrelated", ".claude"), { recursive: true });

    const detected = (await detectHarnesses({ HOME: directory, PATH: "" }))
      .filter((harness) => harness.detected)
      .map((harness) => harness.id);

    expect(detected).toEqual(["opencode", "gemini"]);
  });

  it("auto-installs to every detected native skill directory", async () => {
    const directory = await home();
    await mkdir(path.join(directory, ".config", "opencode"), { recursive: true });
    await mkdir(path.join(directory, ".cline"), { recursive: true });

    const installed = await installSkill("auto", { env: { HOME: directory, PATH: "" } });

    expect(installed.map((item) => item.agents)).toEqual([["OpenCode"], ["Cline"]]);
    expect(installed.map((item) => item.status)).toEqual(["installed", "installed"]);
    for (const item of installed) {
      expect(await readFile(path.join(item.path, "SKILL.md"), "utf8")).toContain("name: boxcompute-sandbox");
      expect(JSON.parse(await readFile(path.join(item.path, ".boxcompute-managed.json"), "utf8")))
        .toMatchObject({ schema: 1, managedBy: "@boxcompute/cli" });
    }

    expect((await installSkill("auto", { env: { HOME: directory, PATH: "" } }))
      .map((item) => item.status)).toEqual(["unchanged", "unchanged"]);
  });

  it("deduplicates harnesses that share the portable Agent Skills directory", async () => {
    const directory = await home();
    await mkdir(path.join(directory, ".config", "goose"), { recursive: true });
    await mkdir(path.join(directory, ".codeium", "windsurf"), { recursive: true });

    const installed = await installSkill("auto", { env: { HOME: directory, PATH: "" } });

    expect(installed).toHaveLength(1);
    expect(installed[0]!.agents).toEqual(["goose", "Windsurf"]);
    expect(installed[0]!.path).toBe(path.join(directory, ".agents", "skills", "boxcompute-sandbox"));
  });

  it("protects a locally modified skill unless force is explicit", async () => {
    const directory = await home();
    const env = { HOME: directory, PATH: "" };
    const [first] = await installSkill("codex", { env });
    await writeFile(path.join(first!.path, "SKILL.md"), "locally modified\n");

    await expect(installSkill("codex", { env })).rejects.toThrow("differs");
    const [updated] = await installSkill("codex", { env, force: true });
    expect(updated!.status).toBe("updated");
    expect(await readFile(path.join(updated!.path, "SKILL.md"), "utf8")).toContain("name: boxcompute-sandbox");
  });

  it("automatically refreshes an untouched managed skill and preserves local edits", async () => {
    const directory = await home();
    const env = { HOME: directory, PATH: "" };
    const [installed] = await installSkill("codex", { env });
    const skillFile = path.join(installed!.path, "SKILL.md");
    const manifestFile = path.join(installed!.path, ".boxcompute-managed.json");

    await writeFile(skillFile, "previous managed version\n");
    await writeFile(manifestFile, `${JSON.stringify({
      schema: 1,
      managedBy: "@boxcompute/cli",
      contentDigest: await contentDigest(installed!.path),
    })}\n`);

    expect((await syncManagedSkills(env))[0]?.status).toBe("updated");
    expect(await readFile(skillFile, "utf8")).toContain("name: boxcompute-sandbox");

    await writeFile(skillFile, "customer customization\n");
    expect((await syncManagedSkills(env))[0]?.status).toBe("modified");
    expect(await readFile(skillFile, "utf8")).toBe("customer customization\n");
  });

  it("removes matching skills idempotently and protects modified copies", async () => {
    const directory = await home();
    const env = { HOME: directory, PATH: "" };
    const [installed] = await installSkill("opencode", { env });

    expect((await removeSkill("opencode", { env }))[0]!.status).toBe("removed");
    expect((await removeSkill("opencode", { env }))[0]!.status).toBe("missing");

    const [reinstalled] = await installSkill("opencode", { env });
    await writeFile(path.join(reinstalled!.path, "SKILL.md"), "locally modified\n");
    await expect(removeSkill("opencode", { env })).rejects.toThrow("differs");
    expect((await removeSkill("opencode", { env, force: true }))[0]!.status).toBe("removed");
    expect(installed!.path).toBe(reinstalled!.path);
  });
});
