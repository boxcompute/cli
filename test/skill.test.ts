import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectHarnesses, installSkill, removeSkill } from "../src/skill.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "bcompute-harnesses-"));
  directories.push(directory);
  return directory;
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
