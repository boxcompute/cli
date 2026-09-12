import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2] ? resolve(process.argv[2]) : new URL("../", import.meta.url);
const { runCli } = await import(typeof packageRoot === "string"
  ? pathToFileURL(join(packageRoot, "dist/cli.js")).href
  : new URL("dist/cli.js", packageRoot).href);
const root = await mkdtemp(join(tmpdir(), "bxc-vm-smoke-"));
const bytes = Buffer.from([0, 255, 128, 10]);
let uploaded;
const io = { stdout: new PassThrough(), stderr: new PassThrough() };
const dependencies = {
  io, env: {}, syncManagedSkills: async () => [],
  loadConnection: async () => ({ url: "https://example.test", token: "test-token", tokenFile: "/unused" }),
  fetch: async (input, init) => {
    const url = new URL(input);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-token");
    if (init.method === "POST") {
      assert.deepEqual(JSON.parse(init.body), { workspaceId: "ws_test", vmSandbox: true });
      assert.equal(new Headers(init.headers).get("idempotency-key"), "saved-key");
      return Response.json({ sandbox: { id: "sbx_vm", vmSandbox: true, state: "pending" } }, { status: 202 });
    }
    if (init.method === "PUT") {
      assert.equal(url.searchParams.get("path"), "/workspace/binary");
      uploaded = Buffer.from(init.body);
      return new Response(null, { status: 204 });
    }
    assert.equal(url.searchParams.get("path"), "/workspace/binary");
    const offset = Number(url.searchParams.get("offset"));
    assert.ok(offset === 0 || offset === 2);
    if (offset === 2) assert.equal(url.searchParams.get("cursor"), "opaque-cursor");
    return new Response(uploaded.subarray(offset, offset + 2), {
      headers: {
        "x-boxcompute-offset": String(offset), "x-boxcompute-next-offset": String(offset + 2),
        "x-boxcompute-file-size": "4", "x-boxcompute-eof": String(offset === 2),
        ...(offset === 0 ? { "x-boxcompute-next-cursor": "opaque-cursor" } : {}),
      },
    });
  },
};
try {
  assert.equal(await runCli(["--json", "sandbox", "start", "ws_test", "--vm", "--idempotency-key", "saved-key"], dependencies), 0);
  assert.equal(JSON.parse(io.stdout.read().toString()).sandbox.state, "pending");
  await writeFile(join(root, "input"), bytes);
  assert.equal(await runCli(["--json", "sandbox", "upload", "sbx_vm", join(root, "input"), "/workspace/binary"], dependencies), 0);
  assert.equal(JSON.parse(io.stdout.read().toString()).bytes, 4);
  assert.deepEqual(uploaded, bytes);
  assert.equal(await runCli(["--json", "sandbox", "download", "sbx_vm", "/workspace/binary", join(root, "output")], dependencies), 0);
  assert.equal(JSON.parse(io.stdout.read().toString()).bytes, 4);
  assert.deepEqual(await readFile(join(root, "output")), bytes);
  console.log(`VM creation and binary file CLI smoke passed on ${process.version}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
