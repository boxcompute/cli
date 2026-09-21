import {
  createCipheriv,
  createPrivateKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "bun:test";
import { sshArguments, unsealSsh } from "../src/ssh.js";

const endpoint = "12345678-1234-4234-8234-123456789abc";
const rawPublic = (key: KeyObject) => key.export({ type: "spki", format: "der" }).subarray(-32);
const recipient = generateKeyPairSync("x25519");
const hostKey = `ssh-ed25519 ${Buffer.concat([
  Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
  Buffer.alloc(32, 7),
]).toString("base64")}`;
const clear = { address: "tc12345", expires_at: 1_250, host_key: hostKey };

function seal(data: unknown = clear, target = recipient.publicKey, id = endpoint): string {
  const pair = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: target });
  const nonce = randomBytes(12);
  const secret = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "boxcompute-connection-v1", 32));
  try {
    const cipher = createCipheriv("aes-256-gcm", secret, nonce);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    return Buffer.concat([rawPublic(pair.publicKey), nonce, ciphertext, cipher.getAuthTag()]).toString("base64");
  } finally {
    shared.fill(0);
    secret.fill(0);
  }
}

describe("cooperative SSH", () => {
  it("unseals the independent envelope produced by the Sandbox guardian", () => {
    const vector = {
      endpointId: "860c4025-508b-4d05-8380-865aaaf8099d",
      issuedAt: 2_000_000_000,
      expiresAt: 2_000_000_030,
      recipientPrivate: "EO2WoayqfUmJBCkgadYupgHQUM0lj4cjsGZTVLMQD28=",
      sealed: "d3GKDwI+FoReVc9HMnwG8y+rFThroo2UqfU3fLTythrx6lUUXssBEo9sh+MC2lP/3oKiirQjf9HkYutAVUNGK2jVGLyMXW03y/KnNOCy0L8dP3BSOK3wh6+do7jkrVmjThvs5Bs7CN3/OZYVNnasYZ33iy3i2/0jWjxKPiVgdfQ6dNJR2lATJadbXpvirgFOWibQx61+NKtM7UBtnZ0sjNUj7gAfSupxmIFOCBEsWBgnSQhN5FHQi5cZ7h279Ef+Dkvwl9UNqQ5N+yq5EnlK",
    };
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b656e04220420", "hex"),
        Buffer.from(vector.recipientPrivate, "base64"),
      ]),
      format: "der",
      type: "pkcs8",
    });
    expect(unsealSsh({
      endpoint_id: vector.endpointId,
      expires_at: vector.expiresAt,
      sealed: vector.sealed,
    }, privateKey, vector.issuedAt)).toMatchObject({
      endpointId: vector.endpointId,
      expiresAt: vector.expiresAt,
      address: "tc-api-guardian",
    });
  });

  it("unseals the authenticated endpoint and clamps to the earlier API lease", () => {
    expect(unsealSsh({ endpoint_id: endpoint, expires_at: 1_200, sealed: seal() }, recipient.privateKey, 1_000)).toEqual({
      endpointId: endpoint,
      expiresAt: 1_200,
      address: "tc12345",
      hostKey,
    });
  });

  it("rejects tampering and private endpoint text", () => {
    expect(() => unsealSsh({ endpoint_id: endpoint, expires_at: 1_200, sealed: seal({ ...clear, address: "private\n" }) }, recipient.privateKey, 1_000)).toThrow("SSH unavailable");
    const bytes = Buffer.from(seal(), "base64");
    bytes[bytes.length - 1]! ^= 1;
    expect(() => unsealSsh({ endpoint_id: endpoint, expires_at: 1_200, sealed: bytes.toString("base64") }, recipient.privateKey, 1_000)).toThrow("SSH unavailable");
  });

  it("pins OpenSSH and escapes ProxyCommand paths", () => {
    const args = sshArguments("/tmp/bxc-%-'demo", "/opt/bxc cli.js");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("PasswordAuthentication=no");
    expect(args).toContain("ClearAllForwardings=yes");
    expect(args.join(" ")).toContain("%%");
    expect(args.at(-1)).toBe("sandbox@boxcompute-endpoint");
  });
});
