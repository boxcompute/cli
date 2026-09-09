import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  throw new Error("usage: node scripts/release-notes.mjs VERSION");
}

const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const start = lines.findIndex((line) => line.startsWith(`## [${version}] - `));
if (start < 0) throw new Error(`CHANGELOG.md has no ${version} release`);

const next = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
const notes = lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
if (!notes) throw new Error(`CHANGELOG.md has empty notes for ${version}`);

process.stdout.write(`${notes}\n`);
