import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
chmodSync(entrypoint, 0o755);
