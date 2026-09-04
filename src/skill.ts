import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_IDS = [
  "claude",
  "codex",
  "amp",
  "opencode",
  "cursor",
  "gemini",
  "copilot",
  "cline",
  "roo",
  "goose",
  "pi",
  "windsurf",
  "agents",
] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];
export type AgentTarget = HarnessId | "auto" | "all" | "both";
export type HarnessDetection = {
  id: HarnessId;
  label: string;
  detected: boolean;
  signals: string[];
  path: string;
  installed: boolean;
};
export type SkillInstallation = { agents: string[]; path: string };
export type SkillInstallationResult = SkillInstallation & {
  status: "installed" | "updated" | "unchanged";
};
export type SkillRemovalResult = SkillInstallation & {
  status: "removed" | "missing";
};
export type SkillSyncResult = SkillInstallation & {
  status: "updated" | "unchanged" | "modified";
};

type Locations = { home: string; config: string; codex: string };
type HarnessDefinition = {
  id: HarnessId;
  label: string;
  commands: string[];
  markers: (locations: Locations) => string[];
  skillRoot: (locations: Locations) => string;
};

const sourceSkill = fileURLToPath(new URL("../skills/boxcompute-sandbox", import.meta.url));
const MANAGED_SKILL_FILE = ".boxcompute-managed.json";
const MANAGED_BY = "@boxcompute/cli";
// @boxcompute/cli 0.1.2 predates managed manifests. Recognizing its packaged
// digest gives existing customers a one-time automatic bridge into managed
// updates without treating arbitrary skill directories as ours.
const LEGACY_MANAGED_DIGESTS = new Set([
  "00d64cd0c71847976baaf6e3d449c0cf1d5fe0d3b3c752b2a05faba906916338",
]);

type ManagedSkillManifest = {
  schema: 1;
  managedBy: typeof MANAGED_BY;
  contentDigest: string;
};

function locations(env: NodeJS.ProcessEnv): Locations {
  const home = env.HOME || homedir();
  return {
    home,
    config: env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, ".config"),
    codex: env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex"),
  };
}

const sharedRoot = ({ home }: Locations) => path.join(home, ".agents", "skills");

const definitions: HarnessDefinition[] = [
  { id: "claude", label: "Claude Code", commands: ["claude"], markers: ({ home }) => [path.join(home, ".claude")], skillRoot: ({ home }) => path.join(home, ".claude", "skills") },
  { id: "codex", label: "Codex", commands: ["codex"], markers: ({ codex }) => [codex], skillRoot: ({ codex }) => path.join(codex, "skills") },
  { id: "amp", label: "Amp", commands: ["amp"], markers: ({ config }) => [path.join(config, "amp")], skillRoot: ({ home }) => path.join(home, ".claude", "skills") },
  { id: "opencode", label: "OpenCode", commands: ["opencode"], markers: ({ config, home }) => [path.join(config, "opencode"), path.join(home, ".opencode")], skillRoot: ({ config }) => path.join(config, "opencode", "skills") },
  { id: "cursor", label: "Cursor", commands: ["cursor", "cursor-agent"], markers: ({ home }) => [path.join(home, ".cursor")], skillRoot: ({ home }) => path.join(home, ".cursor", "skills") },
  { id: "gemini", label: "Gemini CLI", commands: ["gemini"], markers: ({ home }) => [path.join(home, ".gemini")], skillRoot: ({ home }) => path.join(home, ".gemini", "skills") },
  { id: "copilot", label: "GitHub Copilot", commands: ["copilot"], markers: ({ home }) => [path.join(home, ".copilot")], skillRoot: ({ home }) => path.join(home, ".copilot", "skills") },
  { id: "cline", label: "Cline", commands: ["cline"], markers: ({ home }) => [path.join(home, ".cline")], skillRoot: ({ home }) => path.join(home, ".cline", "skills") },
  { id: "roo", label: "Roo Code", commands: ["roo"], markers: ({ home }) => [path.join(home, ".roo")], skillRoot: ({ home }) => path.join(home, ".roo", "skills") },
  { id: "goose", label: "goose", commands: ["goose"], markers: ({ config }) => [path.join(config, "goose")], skillRoot: sharedRoot },
  { id: "pi", label: "Pi", commands: ["pi"], markers: ({ home }) => [path.join(home, ".pi")], skillRoot: ({ home }) => path.join(home, ".pi", "agent", "skills") },
  { id: "windsurf", label: "Windsurf", commands: ["windsurf"], markers: ({ home }) => [path.join(home, ".codeium", "windsurf")], skillRoot: sharedRoot },
  { id: "agents", label: "Agent Skills compatible harnesses", commands: [], markers: ({ home }) => [path.join(home, ".agents")], skillRoot: sharedRoot },
];

async function exists(candidate: string): Promise<boolean> {
  return stat(candidate).then(() => true, () => false);
}

async function directoryDigest(directory: string): Promise<string> {
  const digest = createHash("sha256");
  const walk = async (current: string, prefix = "") => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(current, entry.name);
      if (relative === MANAGED_SKILL_FILE) continue;
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) {
        digest.update(relative);
        digest.update("\0");
        digest.update(await readFile(absolute));
        digest.update("\0");
      } else {
        throw new Error(`Unsupported skill entry: ${relative}`);
      }
    }
  };
  await walk(directory);
  return digest.digest("hex");
}

async function matchesPackagedSkill(candidate: string): Promise<boolean> {
  try {
    return await directoryDigest(candidate) === await directoryDigest(sourceSkill);
  } catch {
    return false;
  }
}

async function managedManifest(candidate: string): Promise<ManagedSkillManifest | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(candidate, MANAGED_SKILL_FILE), "utf8"),
    ) as Partial<ManagedSkillManifest>;
    return parsed.schema === 1 && parsed.managedBy === MANAGED_BY &&
      typeof parsed.contentDigest === "string"
      ? parsed as ManagedSkillManifest
      : null;
  } catch {
    return null;
  }
}

async function writeManagedManifest(candidate: string): Promise<void> {
  const manifest: ManagedSkillManifest = {
    schema: 1,
    managedBy: MANAGED_BY,
    contentDigest: await directoryDigest(candidate),
  };
  await writeFile(
    path.join(candidate, MANAGED_SKILL_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function isUnmodifiedManagedSkill(candidate: string): Promise<boolean> {
  try {
    const currentDigest = await directoryDigest(candidate);
    if (LEGACY_MANAGED_DIGESTS.has(currentDigest)) return true;
    const manifest = await managedManifest(candidate);
    return manifest?.contentDigest === currentDigest;
  } catch {
    return false;
  }
}

async function replaceWithPackagedSkill(candidate: string): Promise<void> {
  await mkdir(path.dirname(candidate), { recursive: true });
  const temporary = `${candidate}.tmp-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await cp(sourceSkill, temporary, { recursive: true });
  await writeManagedManifest(temporary);
  await rm(candidate, { recursive: true, force: true });
  await rename(temporary, candidate);
}

async function commandExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!env.PATH) return false;
  const extensions = process.platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const directory of env.PATH.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const executable = path.join(directory, `${command}${extension}`);
      if (await access(executable, constants.X_OK).then(() => true, () => false)) return true;
    }
  }
  return false;
}

export async function detectHarnesses(env: NodeJS.ProcessEnv = process.env): Promise<HarnessDetection[]> {
  const resolved = locations(env);
  return Promise.all(definitions.map(async (definition) => {
    const signals: string[] = [];
    const skillPath = path.join(definition.skillRoot(resolved), "boxcompute-sandbox");
    for (const marker of definition.markers(resolved)) {
      if (await exists(marker)) signals.push(marker);
    }
    for (const command of definition.commands) {
      if (await commandExists(command, env)) signals.push(`command:${command}`);
    }
    return {
      id: definition.id,
      label: definition.label,
      detected: signals.length > 0,
      signals,
      path: skillPath,
      installed: await exists(skillPath),
    };
  }));
}

function expandedTargets(targets: AgentTarget[]): HarnessId[] | "auto" | "all" {
  if (targets.includes("auto")) {
    if (targets.length !== 1) throw new Error("auto cannot be combined with other harnesses");
    return "auto";
  }
  if (targets.includes("all")) {
    if (targets.length !== 1) throw new Error("all cannot be combined with other harnesses");
    return "all";
  }
  return [...new Set(targets.flatMap((target) => target === "both" ? ["claude", "codex"] : [target]))] as HarnessId[];
}

export async function installSkill(
  requested: AgentTarget | AgentTarget[] = "auto",
  options: { force?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<SkillInstallationResult[]> {
  const env = options.env ?? process.env;
  const detections = await detectHarnesses(env);
  const targets = expandedTargets(Array.isArray(requested) ? requested : [requested]);
  const selected = targets === "all"
    ? detections
    : targets === "auto"
      ? detections.filter((item) => item.detected)
      : targets.map((id) => detections.find((item) => item.id === id)!);
  if (!selected.length) {
    throw new Error("No supported coding harnesses detected. Name one explicitly or use `bxc skill install all`.");
  }

  const destinations = new Map<string, SkillInstallation>();
  for (const target of selected) {
    const current = destinations.get(target.path);
    if (current) current.agents.push(target.label);
    else destinations.set(target.path, { agents: [target.label], path: target.path });
  }
  const installations = [...destinations.values()];

  const planned = await Promise.all(installations.map(async (item): Promise<SkillInstallationResult> => {
    if (!await exists(item.path)) return { ...item, status: "installed" };
    if (options.force) return { ...item, status: "updated" };
    if (await matchesPackagedSkill(item.path)) return { ...item, status: "unchanged" };
    if (await isUnmodifiedManagedSkill(item.path)) return { ...item, status: "updated" };
    throw new Error(`${item.path} already exists and differs; pass --force to replace it`);
  }));

  for (const item of planned) {
    if (item.status === "unchanged") await writeManagedManifest(item.path);
    else await replaceWithPackagedSkill(item.path);
  }
  return planned;
}

/** Refresh untouched skill copies installed by bxc, preserving local edits. */
export async function syncManagedSkills(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkillSyncResult[]> {
  const detections = await detectHarnesses(env);
  const destinations = new Map<string, SkillInstallation>();
  for (const target of detections.filter((item) => item.installed)) {
    const current = destinations.get(target.path);
    if (current) current.agents.push(target.label);
    else destinations.set(target.path, { agents: [target.label], path: target.path });
  }
  const sourceDigest = await directoryDigest(sourceSkill);
  const results: SkillSyncResult[] = [];
  for (const item of destinations.values()) {
    const currentDigest = await directoryDigest(item.path);
    if (currentDigest === sourceDigest) {
      await writeManagedManifest(item.path);
      results.push({ ...item, status: "unchanged" });
    } else if (await isUnmodifiedManagedSkill(item.path)) {
      await replaceWithPackagedSkill(item.path);
      results.push({ ...item, status: "updated" });
    } else {
      results.push({ ...item, status: "modified" });
    }
  }
  return results;
}

export async function removeSkill(
  requested: AgentTarget | AgentTarget[] = "auto",
  options: { force?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<SkillRemovalResult[]> {
  const env = options.env ?? process.env;
  const detections = await detectHarnesses(env);
  const targets = expandedTargets(Array.isArray(requested) ? requested : [requested]);
  const selected = targets === "all"
    ? detections
    : targets === "auto"
      ? detections.filter((item) => item.detected || item.installed)
      : targets.map((id) => detections.find((item) => item.id === id)!);
  if (!selected.length) {
    throw new Error("No supported coding harnesses detected. Name one explicitly or use `bxc skill remove all --yes`.");
  }

  const destinations = new Map<string, SkillInstallation>();
  for (const target of selected) {
    const current = destinations.get(target.path);
    if (current) current.agents.push(target.label);
    else destinations.set(target.path, { agents: [target.label], path: target.path });
  }
  const removals = await Promise.all([...destinations.values()].map(async (item): Promise<SkillRemovalResult> => {
    if (!await exists(item.path)) return { ...item, status: "missing" };
    if (!options.force &&
      !await matchesPackagedSkill(item.path) &&
      !await isUnmodifiedManagedSkill(item.path)) {
      throw new Error(`${item.path} differs from the packaged skill; pass --force to remove it`);
    }
    return { ...item, status: "removed" };
  }));

  for (const item of removals) {
    if (item.status === "removed") await rm(item.path, { recursive: true, force: true });
  }
  return removals;
}

export async function readSkill(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path.join(sourceSkill, "SKILL.md"), "utf8");
}
