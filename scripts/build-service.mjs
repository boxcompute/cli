import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = fileURLToPath(new URL("../native/service-client/", import.meta.url));
const output = fileURLToPath(new URL("../dist/native/", import.meta.url));
const licenseRoot = fileURLToPath(new URL("../dist/native-licenses/", import.meta.url));
rmSync(output, { recursive: true, force: true });
rmSync(licenseRoot, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
mkdirSync(licenseRoot, { recursive: true });
const tools = mkdtempSync(join(tmpdir(), "bxc-service-tools-"));
const hostEnv = { ...process.env, GOTOOLCHAIN: "go1.27.1", GOBIN: tools };

try {
  const installed = spawnSync("go", ["install", "github.com/google/go-licenses/v2@v2.0.1"], { env: hostEnv, stdio: "inherit" });
  if (installed.error || installed.status !== 0) throw new Error("Could not prepare native license inventory");
  for (const [platform, goos] of [["linux", "linux"], ["darwin", "darwin"]]) {
    for (const [arch, goarch] of [["x64", "amd64"], ["arm64", "arm64"]]) {
      const env = { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0", GOTOOLCHAIN: "go1.27.1" };
      const target = `${output}boxcompute-service-${platform}-${arch}`;
      const built = spawnSync("go", ["build", "-mod=readonly", "-trimpath", "-ldflags=-s -w", "-o", target, "."], {
        cwd: source, env, stdio: "inherit",
      });
      if (built.error || built.status !== 0) throw new Error(`Could not build service client for ${platform}/${arch}`);
      chmodSync(target, 0o755);
      const licenses = spawnSync(join(tools, "go-licenses"), [
        "save", ".", "--save_path", join(licenseRoot, `${platform}-${arch}`),
        "--ignore", "github.com/boxcompute/cli", "--force",
      ], { cwd: source, env, stdio: "inherit" });
      if (licenses.error || licenses.status !== 0) throw new Error(`Could not collect licenses for ${platform}/${arch}`);
    }
  }
  const goroot = spawnSync("go", ["env", "GOROOT"], { env: hostEnv, encoding: "utf8" });
  if (goroot.error || goroot.status !== 0) throw new Error("Could not locate Go runtime license");
  copyFileSync(join(goroot.stdout.trim(), "LICENSE"), join(licenseRoot, "Go-LICENSE"));
} finally {
  rmSync(tools, { recursive: true, force: true });
}
