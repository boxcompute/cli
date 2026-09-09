import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(base ?? "")) {
  throw new Error("usage: node scripts/validate-release-change.mjs BASE_SHA");
}

const changed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], {
  encoding: "utf8",
}).trim().split("\n").filter(Boolean);
const distributablePath = changed.some((path) =>
  path === "README.md" ||
  path === "tsconfig.build.json" ||
  path.startsWith("src/") ||
  path.startsWith("skills/"));

const currentPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const basePackage = JSON.parse(execFileSync("git", ["show", `${base}:package.json`], {
  encoding: "utf8",
}));

function publishedMetadata(value) {
  const result = structuredClone(value);
  delete result.version;
  delete result.devDependencies;
  delete result.packageManager;
  return result;
}

const metadataChanged = JSON.stringify(publishedMetadata(currentPackage)) !==
  JSON.stringify(publishedMetadata(basePackage));
const versionChanged = currentPackage.version !== basePackage.version;

if (!distributablePath && !metadataChanged && !versionChanged) {
  console.log("No distributable CLI change; version check skipped");
  process.exit(0);
}
if ((distributablePath || metadataChanged) && !versionChanged) {
  throw new Error(`distributable files changed without a version bump from ${basePackage.version}`);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(currentPackage.version)) {
  throw new Error(`invalid semantic version: ${currentPackage.version}`);
}

const lookup = spawnSync("npm", [
  "view",
  `${currentPackage.name}@${currentPackage.version}`,
  "version",
], { encoding: "utf8" });
if (lookup.status === 0) {
  throw new Error(`${currentPackage.name}@${currentPackage.version} already exists on npm`);
}
const lookupError = `${lookup.stdout ?? ""}\n${lookup.stderr ?? ""}`;
if (!lookupError.includes("E404") && !lookupError.includes("No match found for version")) {
  throw new Error(`could not verify npm release state: ${lookupError.trim()}`);
}

execFileSync(process.execPath, [
  fileURLToPath(new URL("./release-notes.mjs", import.meta.url)),
  currentPackage.version,
], { stdio: "ignore" });
console.log(`Validated unpublished release ${currentPackage.name}@${currentPackage.version}`);
