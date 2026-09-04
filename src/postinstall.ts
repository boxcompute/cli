import { syncManagedSkills } from "./skill.js";

// A global CLI upgrade happens before the user starts their coding harness, so
// this is the one point where an untouched installed skill can be refreshed in
// time for the next agent session. Package managers that suppress lifecycle
// scripts still get the same safe check on the next normal bxc invocation.
const globalInstall = process.env.npm_config_global === "true" ||
  process.env.npm_config_global === "1";

if (globalInstall) {
  try {
    const results = await syncManagedSkills(process.env);
    const updated = results.filter((item) => item.status === "updated");
    const modified = results.filter((item) => item.status === "modified");
    if (updated.length) {
      console.log(
        `Updated the BoxCompute skill for ${updated.flatMap((item) => item.agents).join(", ")}.`,
      );
    }
    for (const item of modified) {
      console.warn(
        `Kept locally modified BoxCompute skill at ${item.path}; ` +
        "run `bxc skill install --force` to replace it.",
      );
    }
  } catch (error) {
    console.warn(
      `Could not check installed BoxCompute skills: ${(error as Error)?.message ?? String(error)}`,
    );
  }
}
