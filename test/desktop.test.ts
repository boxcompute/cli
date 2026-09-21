import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";
import { runCli } from "../src/cli.js";
import type { ServiceAccessResponse } from "../src/client.js";
import { SERVICE_CLIENT_RELEASE_TAG, openServices, type ServiceAccessApi, type ServiceMapping } from "../src/services-session.js";

function streams() {
  return { stdout: new PassThrough(), stderr: new PassThrough() };
}

function output(stream: PassThrough): string {
  let value = "";
  let chunk: Buffer | null;
  while ((chunk = stream.read() as Buffer | null) !== null) value += chunk.toString();
  return value;
}

const connection = {
  url: "https://app.boxcompute.ai",
  token: "bc_live_test",
  tokenFile: "/credential",
};

const generation = "3f0a1c2e-5b6d-4c7e-8f90-112233445566";
const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const expiresAtIso = new Date(expiresAt * 1000).toISOString();

type SessionControls = { closeCalls: number; closeError?: Error; closedError?: Error };

function fakeSession(controls: SessionControls) {
  const closed = controls.closedError ? Promise.reject<void>(controls.closedError) : new Promise<void>(() => undefined);
  if (controls.closedError) closed.catch(() => undefined);
  return {
    generationId: generation,
    expiresAt,
    closed,
    close: async () => {
      controls.closeCalls += 1;
      if (controls.closeError) throw controls.closeError;
    },
  };
}

function desktopDependencies(overrides: Partial<{
  openSession: typeof openServices;
  fetch: typeof fetch;
  io: { stdout: PassThrough; stderr: PassThrough };
}> = {}) {
  const io = overrides.io ?? streams();
  const captured: { handler?: () => void } = {};
  return {
    io: { stdout: io.stdout, stderr: io.stderr } as const,
    text: io,
    env: {},
    fetch: overrides.fetch ?? ((async () => { throw new Error("should not fetch"); }) as unknown as typeof fetch),
    openSession: overrides.openSession ??
      ((async () => fakeSession({ closeCalls: 0 })) as unknown as typeof openServices),
    desktopSignals: (handler: () => void) => {
      captured.handler = handler;
      return () => undefined;
    },
    captured,
  };
}

function desktopRun(argv: string[], dependencies: ReturnType<typeof desktopDependencies>, overrides: Record<string, unknown> = {}) {
  return runCli(argv, {
    io: dependencies.io,
    env: dependencies.env,
    loadConnection: async () => connection,
    fetch: dependencies.fetch,
    openDesktopSession: dependencies.openSession,
    desktopSignals: dependencies.desktopSignals,
    ...overrides,
  }) as Promise<number>;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

async function listenOnPort(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", resolve);
    server.listen({ port, host: "127.0.0.1" });
  });
  return server;
}

describe("bxc desktop", () => {
  it("prints the desktop help block and lists the command in root help", async () => {
    const io = streams();
    expect(await runCli(["desktop", "--help"], { io, env: {} })).toBe(0);
    const help = output(io.stdout);
    expect(help).toContain("Usage: bxc desktop SANDBOX_ID [options]");
    expect(help).toContain("--local-port PORT");

    const root = streams();
    expect(await runCli(["--help"], { io: root, env: {} })).toBe(0);
    expect(output(root.stdout)).toContain("desktop SANDBOX_ID");
  });

  it("requires a sandbox ID and rejects unknown options", async () => {
    const dependencies = desktopDependencies();
    await expect(runCli(["desktop"], {
      io: dependencies.io, env: dependencies.env, loadConnection: async () => connection,
    })).rejects.toThrow("desktop requires a sandbox ID");
    await expect(runCli(["desktop", "sbx-one", "--local-port", "zero"], {
      io: dependencies.io, env: dependencies.env, loadConnection: async () => connection,
    })).rejects.toThrow("--local-port must be a positive integer");
    await expect(runCli(["desktop", "sbx-one", "--retry"], {
      io: dependencies.io, env: dependencies.env, loadConnection: async () => connection,
    })).rejects.toThrow("Unknown desktop option: --retry");
  });

  it("rejects non-HTTPS connection URLs before any request", async () => {
    const dependencies = desktopDependencies();
    await expect(runCli(["desktop", "sbx-one"], {
      io: dependencies.io,
      env: dependencies.env,
      loadConnection: async () => ({ ...connection, url: "http://app.boxcompute.ai" }),
      fetch: dependencies.fetch,
    })).rejects.toThrow("HTTPS-only");
  });

  it("fails on a busy local port before requesting any grant", async () => {
    let requests = 0;
    const server = await listenOnPort(0);
    const port = (server.address() as { port: number }).port;
    const dependencies = desktopDependencies({
      fetch: (async () => {
        requests += 1;
        throw new Error("should not fetch");
      }) as unknown as typeof fetch,
    });
    try {
      await expect(runCli(["desktop", "sbx-one", "--local-port", String(port)], {
        io: dependencies.io,
        env: dependencies.env,
        loadConnection: async () => connection,
        fetch: dependencies.fetch,
      })).rejects.toThrow(`Local port ${port} is already in use`);
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("opens a session with one 5900 mapping, prints the endpoint, and closes on the signal", async () => {
    const io = streams();
    const controls = { closeCalls: 0 };
    const sessions: Array<{ api: ServiceAccessApi; mappings: readonly ServiceMapping[] }> = [];
    const dependencies = desktopDependencies({
      openSession: (async (api: ServiceAccessApi, mappings: readonly ServiceMapping[]) => {
        sessions.push({ api, mappings });
        return fakeSession(controls);
      }) as unknown as typeof openServices,
      io,
    });
    const pending = desktopRun(["desktop", "sbx-one", "--local-port", "15900"], dependencies, {
      now: () => expiresAt * 1000 - 5 * 60_000,
    });
    await settle();
    dependencies.captured.handler!();
    expect(await pending).toBe(0);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.mappings).toEqual([{ local: 15900, remote: 5900 }]);
    expect(controls.closeCalls).toBe(1);
    expect(output(io.stdout)).toBe(
      "Desktop endpoint: 127.0.0.1:15900 (RFB/VNC)\n" +
      "Sandbox: sbx-one\n" +
      `Generation: ${generation}\n` +
      `Expires at: ${expiresAtIso} (5 minutes remaining)\n` +
      "Press Ctrl-C to close the session and revoke access.\n" +
      "If nothing is listening, run `desktopctl start` inside the sandbox.\n" +
      "Desktop session closed; access revoked.\n",
    );
  });

  it("emits one JSON object with the session fields and stays in the foreground", async () => {
    const io = streams();
    const controls = { closeCalls: 0 };
    const dependencies = desktopDependencies({
      io,
      openSession: (async () => fakeSession(controls)) as unknown as typeof openServices,
    });
    const pending = desktopRun(["--json", "desktop", "sbx-one"], dependencies, {
      now: () => expiresAt * 1000 - 30 * 60_000,
    });
    await settle();
    dependencies.captured.handler!();
    expect(await pending).toBe(0);

    const [payloadLine] = output(io.stdout).split("\n");
    expect(JSON.parse(payloadLine!)).toEqual({
      sandboxId: "sbx-one",
      endpoint: "127.0.0.1:5900",
      localPort: 5900,
      remotePort: 5900,
      generationId: generation,
      expiresAt: expiresAtIso,
      minutesRemaining: 30,
    });
    expect(controls.closeCalls).toBe(1);
  });

  it("surfaces an unconfirmed revocation with the original expiry and exits non-zero", async () => {
    const io = streams();
    const controls = {
      closeCalls: 0,
      closeError: new Error(
        "Service access unavailable; no mutation retry was attempted. Unconfirmed access expires at its original deadline.",
      ),
    };
    const dependencies = desktopDependencies({
      io,
      openSession: (async () => fakeSession(controls)) as unknown as typeof openServices,
    });
    const pending = desktopRun(["desktop", "sbx-one"], dependencies, { now: () => expiresAt * 1000 });
    await settle();
    dependencies.captured.handler!();
    expect(await pending).toBe(1);
    const stderr = output(io.stderr);
    expect(stderr).toContain("Unconfirmed access expires at its original deadline");
    expect(stderr).toContain(expiresAtIso);
  });

  it("reports a session that expires while it is running and exits non-zero", async () => {
    const io = streams();
    const rejected: Promise<void> = Promise.reject(
      new Error("Service access unavailable; no mutation retry was attempted."),
    );
    rejected.catch(() => undefined);
    const dependencies = desktopDependencies({
      io,
      openSession: (async () => ({
        generationId: generation,
        expiresAt,
        closed: rejected,
        close: async () => { throw new Error("should not close cleanly"); },
      })) as unknown as typeof openServices,
    });
    expect(await desktopRun(["desktop", "sbx-one"], dependencies, { now: () => expiresAt * 1000 })).toBe(1);
    const stderr = output(io.stderr);
    expect(stderr).toContain("Desktop session disconnected");
    expect(stderr).toContain(expiresAtIso);
  });

  it("tells the user to set BOXCOMPUTE_SERVICE_CLIENT while the release is unpublished", async () => {
    await expect(openServices({
      createServiceAccess: async () => ({ generation_id: "", expires_at: 0, sealed: "" } as ServiceAccessResponse),
      lookupServiceAccess: async () => ({ generation_id: "", expires_at: 0, sealed: "" } as ServiceAccessResponse),
      revokeServiceAccess: async () => undefined,
    }, [{ local: 5900, remote: 5900 }])).rejects.toThrow(
      `The pinned service-client release (${SERVICE_CLIENT_RELEASE_TAG}/boxcompute-proxy-linux-x64) is not published yet`,
    );
  });
});
