import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = fileURLToPath(new URL("../native/connection-proxy/", import.meta.url));
const output = fileURLToPath(new URL("../dist/native/", import.meta.url));
const licenseRoot = fileURLToPath(new URL("../dist/native-licenses/", import.meta.url));
// build:native runs both helper builds into the same directories, so remove
// only this helper's binaries and license inventory, never the other's.
mkdirSync(output, { recursive: true });
for (const name of readdirSync(output)) {
  if (name.startsWith("boxcompute-proxy-")) rmSync(join(output, name), { force: true });
}
rmSync(join(licenseRoot, "connection-proxy"), { recursive: true, force: true });
mkdirSync(licenseRoot, { recursive: true });
const tools = mkdtempSync(join(tmpdir(), "bxc-package-tools-"));
const hostEnv = {
  ...process.env,
  GOTOOLCHAIN: "go1.27.1",
  GOBIN: tools,
  GOOS: process.platform,
  GOARCH: process.arch === "x64" ? "amd64" : process.arch,
};

try {
  const installed = spawnSync(
    "go",
    ["install", "github.com/google/go-licenses/v2@v2.0.1"],
    { env: hostEnv, stdio: "inherit" },
  );
  if (installed.error || installed.status !== 0) throw new Error("Could not prepare native license inventory");
  for (const [platform, goos] of [["linux", "linux"], ["darwin", "darwin"]]) {
    for (const [arch, goarch] of [["x64", "amd64"], ["arm64", "arm64"]]) {
      const targetEnv = { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0", GOTOOLCHAIN: "go1.27.1" };
      const result = spawnSync(
        "go",
        ["build", "-mod=readonly", "-trimpath", "-ldflags=-s -w", "-o", `${output}boxcompute-proxy-${platform}-${arch}`, "."],
        { cwd: source, env: targetEnv, stdio: "inherit" },
      );
      if (result.error || result.status !== 0) throw new Error(`Could not build connection proxy for ${platform}/${arch}`);
      chmodSync(`${output}boxcompute-proxy-${platform}-${arch}`, 0o755);
      const licenses = spawnSync(
        join(tools, "go-licenses"),
        ["save", ".", "--save_path", join(licenseRoot, "connection-proxy", `${platform}-${arch}`), "--ignore", "github.com/boxcompute/cli", "--force"],
        { cwd: source, env: targetEnv, stdio: "inherit" },
      );
      if (licenses.error || licenses.status !== 0) throw new Error(`Could not collect licenses for ${platform}/${arch}`);
    }
  }
  const goroot = spawnSync("go", ["env", "GOROOT"], { env: hostEnv, encoding: "utf8" });
  if (goroot.error || goroot.status !== 0) throw new Error("Could not locate Go runtime license");
  rmSync(join(licenseRoot, "Go-LICENSE"), { force: true });
  copyFileSync(join(goroot.stdout.trim(), "LICENSE"), join(licenseRoot, "Go-LICENSE"));
} finally {
  rmSync(tools, { recursive: true, force: true });
}
