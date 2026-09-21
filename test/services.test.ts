import { describe, expect, it } from "bun:test";
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { unsealServices } from "../src/services.js";
import type { ServiceAccessRequest } from "../src/service-access.js";

const generation = "11234567-89ab-4cde-8fab-0123456789ab";

function seal(request: ServiceAccessRequest, change: Record<string, unknown> = {}) {
  const sender = generateKeyPairSync("x25519");
  const recipient = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"),
      Buffer.from(request.recipient_key, "base64"),
    ]),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey: sender.privateKey, publicKey: recipient });
  const nonce = randomBytes(12);
  const secret = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "boxcompute-connection-v1", 32));
  const cipher = createCipheriv("aes-256-gcm", secret, nonce);
  cipher.setAAD(Buffer.from(generation));
  const clear = JSON.stringify({
    address: "tc-test-address",
    expires_at: request.requested_at + 300,
    ports: request.ports,
    ...change,
  });
  const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
  shared.fill(0);
  secret.fill(0);
  return {
    generation_id: generation,
    expires_at: request.requested_at + 300,
    sealed: Buffer.concat([
      sender.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
      nonce,
      ciphertext,
      cipher.getAuthTag(),
    ]).toString("base64"),
  };
}

describe("service capability envelope", () => {
  it("binds the exact generation, expiry, and remote ports", () => {
    const recipient = generateKeyPairSync("x25519");
    const request: ServiceAccessRequest = {
      operation_id: generation,
      requested_at: Math.floor(Date.now() / 1_000),
      client_key: `nodekey:${"1".repeat(64)}`,
      recipient_key: recipient.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
      ports: [3000, 8080],
    };
    const good = seal(request);
    expect(unsealServices(good, recipient.privateKey, request)).toEqual({
      address: "tc-test-address",
      expires_at: request.requested_at + 300,
    });
    for (const bad of [
      seal(request, { ports: [3000, 9090] }),
      seal(request, { expires_at: request.requested_at + 299 }),
      { ...good, expires_at: good.expires_at + 1 },
      { ...good, generation_id: "21234567-89ab-4cde-8fab-0123456789ab" },
    ]) {
      expect(() => unsealServices(bad, recipient.privateKey, request)).toThrow("Service access unavailable");
    }
  });
});
