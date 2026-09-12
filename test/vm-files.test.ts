import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BoxComputeClient, FILE_CHUNK_BYTES } from "../src/client.js";
import { downloadFile, uploadFile } from "../src/files.js";
import { runCli } from "../src/cli.js";

const connection = { url: "https://app.boxcompute.ai", token: "test-credential", tokenFile: "/unused" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const client = (handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  new BoxComputeClient(connection, handler as typeof fetch);
const page = (bytes: Uint8Array, offset: number, size: number, cursor?: string) => new Response(new Uint8Array(bytes), {
  headers: {
    "x-boxcompute-offset": String(offset), "x-boxcompute-next-offset": String(offset + bytes.length),
    "x-boxcompute-file-size": String(size), "x-boxcompute-eof": String(offset + bytes.length === size),
    ...(cursor ? { "x-boxcompute-next-cursor": cursor } : {}),
  },
});

async function directory(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "bxc-files-test-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe("VM creation", () => {
  it("reports the allocated ID if an older server silently ignores VM selection", async () => {
    let calls = 0;
    const api = client(async () => {
      calls++;
      return json({ sandbox: { id: "sbx_wrong_profile", state: "running" } }, 201);
    });
    await expect(api.start("ws_one", { vmSandbox: true, idempotencyKey: "saved-key" })).rejects.toThrow("sbx_wrong_profile");
    expect(calls).toBe(1);
  });
  it("preserves the key and body across explicit pending and completed replays", async () => {
    const calls: RequestInit[] = [];
    const api = client(async (_, init) => {
      calls.push(init!);
      return json({ sandbox: { id: "sbx_vm", vmSandbox: true, state: calls.length === 1 ? "pending" : "running" } }, calls.length === 1 ? 202 : 201);
    });
    const options = { vmSandbox: true, idempotencyKey: "vm-unique", name: " Test " };
    expect((await api.start("ws_one", options)).state).toBe("pending");
    expect((await api.start("ws_one", options)).id).toBe("sbx_vm");
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toBe(calls[1].body);
    expect(JSON.parse(String(calls[0].body))).toEqual({ workspaceId: "ws_one", vmSandbox: true, name: "Test" });
    expect(new Headers(calls[0].headers).get("idempotency-key")).toBe("vm-unique");
    expect(calls[0].redirect).toBe("error");
  });

  it("rejects invalid keys and names before allocating", async () => {
    let calls = 0;
    const api = client(async () => { calls++; throw new Error("unexpected request"); });
    for (const key of [undefined, "", "bad key", "a".repeat(256), "bad\nkey"]) {
      await expect(api.start("ws_one", { vmSandbox: true, idempotencyKey: key })).rejects.toThrow();
    }
    await expect(api.start("ws_one", { name: " " })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("does not retry or fall back after an ambiguous create or conflict", async () => {
    for (const failure of ["timeout", "conflict"]) {
      let calls = 0;
      const api = client(async () => {
        calls++;
        if (failure === "timeout") throw new Error("timeout");
        return json({ code: "IDEMPOTENCY_CONFLICT", error: "conflict" }, 409);
      });
      await expect(api.start("ws_one", { vmSandbox: true, idempotencyKey: "fixed-key" })).rejects.toThrow(failure);
      expect(calls).toBe(1);
    }
  });

  it("exposes pending and expired states through CLI JSON", async () => {
    const io = { stdout: new PassThrough(), stderr: new PassThrough() };
    let calls = 0;
    const dependencies = {
      io, env: {}, loadConnection: async () => connection, syncManagedSkills: async () => [],
      fetch: (async (_: unknown, init?: RequestInit) => {
        calls++;
        if (init?.method === "POST") {
          expect(JSON.parse(String(init.body)).vmSandbox).toBe(true);
          return json({ sandbox: { id: "sbx_vm", vmSandbox: true, state: "pending" } }, 202);
        }
        return json({ sandbox: { id: "sbx_vm", vmSandbox: true, state: "expired" } });
      }) as typeof fetch,
    };
    await expect(runCli(["sandbox", "start", "ws_one", "--vm"], dependencies)).rejects.toThrow("--idempotency-key");
    expect(calls).toBe(0);
    expect(await runCli(["--json", "sandbox", "start", "ws_one", "--vm", "--idempotency-key", "key"], dependencies)).toBe(0);
    expect(JSON.parse(io.stdout.read().toString()).sandbox.state).toBe("pending");
    expect(await runCli(["--json", "sandbox", "status", "sbx_vm"], dependencies)).toBe(0);
    expect(JSON.parse(io.stdout.read().toString()).sandbox.state).toBe("expired");
  });
});

describe("file transfers", () => {
  it("uploads exact binary bytes with encoded paths and bounded requests", async () => directory(async (root) => {
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    const local = join(root, "input");
    await writeFile(local, bytes);
    let calls = 0;
    const api = client(async (url, init) => {
      calls++;
      expect(new URL(String(url)).searchParams.get("path")).toBe("/workspace/a #?.bin");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-credential");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/octet-stream");
      expect(init?.method).toBe("PUT");
      expect(init?.redirect).toBe("error");
      expect(Buffer.from(init?.body as Uint8Array)).toEqual(bytes);
      return new Response(null, { status: 204 });
    });
    expect(await uploadFile(api, "sbx_one", local, "/workspace/a #?.bin")).toBe(bytes.length);
    expect(calls).toBe(1);
    await writeFile(local, Buffer.alloc(FILE_CHUNK_BYTES + 1));
    await expect(uploadFile(api, "sbx_one", local, "/workspace/large")).rejects.toThrow("8 MiB");
    for (const path of ["relative", "/workspace-other/file", "/workspace/../file", "/workspace/./file", "/workspace/a\0b"]) {
      await expect(api.upload("sbx_one", path, bytes)).rejects.toThrow("Remote file paths");
    }
    expect(calls).toBe(1);
  }));

  it("follows offsets and opaque cursors until EOF without mixing bytes", async () => directory(async (root) => {
    let calls = 0;
    const api = client(async (url, init) => {
      const query = new URL(String(url)).searchParams;
      expect(new Headers(init?.headers).has("range")).toBe(false);
      expect(query.get("maxBytes")).toBe(String(FILE_CHUNK_BYTES));
      calls++;
      if (calls === 1) {
        expect(query.get("offset")).toBe("0");
        expect(query.has("cursor")).toBe(false);
        return page(new Uint8Array([0, 255]), 0, 4, "opaque+/=?");
      }
      expect(query.get("offset")).toBe("2");
      expect(query.get("cursor")).toBe("opaque+/=?");
      return page(new Uint8Array([128, 10]), 2, 4);
    });
    const local = join(root, "result");
    expect(await downloadFile(api, "sbx_one", "/workspace/file", local)).toBe(4);
    expect(await readFile(local)).toEqual(Buffer.from([0, 255, 128, 10]));
    expect(await readdir(root)).toEqual(["result"]);
    await expect(downloadFile(api, "sbx_one", "/workspace/file", local)).rejects.toThrow("already exists");
    expect(calls).toBe(2);
  }));

  it("discards partial output on a stale cursor or unavailable VM without retries", async () => directory(async (root) => {
    for (const [code, status] of [["CURSOR_STALE", 409], ["SANDBOX_UNAVAILABLE", 503]] as const) {
      let calls = 0;
      const api = client(async () => ++calls === 1 ? page(new Uint8Array([1]), 0, 2, "cursor") : json({ code, error: code }, status));
      await expect(downloadFile(api, "sbx_one", "/workspace/file", join(root, code))).rejects.toThrow(code);
      expect(calls).toBe(2);
      expect(await readdir(root)).toEqual([]);
    }
  }));

  it("rejects malformed, non-progressing, oversized and incomplete range responses", async () => {
    const responses = [
      new Response("data"),
      page(new Uint8Array(), 0, 2, "cursor"),
      page(new Uint8Array([1]), 0, 2),
      page(new Uint8Array([1]), 1, 2),
      new Response(new Uint8Array([1, 2]), { headers: page(new Uint8Array([1]), 0, 1).headers }),
      new Response(null, { headers: page(new Uint8Array([1]), 0, 1).headers }),
    ];
    for (const response of responses) {
      await expect(client(async () => response).readFile("sbx_one", "/workspace/file")).rejects.toThrow();
    }
  });

  it("downloads empty files and refuses a destination created during transfer", async () => directory(async (root) => {
    const local = join(root, "result");
    const empty = client(async () => page(new Uint8Array(), 0, 0));
    expect(await downloadFile(empty, "sbx_one", "/workspace/empty", local)).toBe(0);
    expect((await readFile(local)).length).toBe(0);
    await rm(local);
    const racing = client(async () => {
      await writeFile(local, "keep me");
      return page(new Uint8Array([1]), 0, 1);
    });
    await expect(downloadFile(racing, "sbx_one", "/workspace/file", local)).rejects.toThrow();
    expect(await readFile(local, "utf8")).toBe("keep me");
    expect(await readdir(root)).toEqual(["result"]);
  }));

  it("discards output when the reported file size changes between pages", async () => directory(async (root) => {
    let calls = 0;
    const api = client(async () => ++calls === 1
      ? page(new Uint8Array([1]), 0, 2, "cursor")
      : page(new Uint8Array([2, 3]), 1, 3));
    await expect(downloadFile(api, "sbx_one", "/workspace/file", join(root, "result"))).rejects.toThrow("File size changed");
    expect(await readdir(root)).toEqual([]);
  }));
});
