import { describe, it, expect } from "vitest";
import {
  randomToken, sha256hex, safeEqual, hashPin, verifyPin,
  encryptJson, decryptJson, verifySignature,
} from "../src/crypto.js";

const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytesToB64 = (b) => btoa(String.fromCharCode(...b));
const keyB64 = (n = 1) => bytesToB64(new Uint8Array(32).fill(n));

describe("randomToken", () => {
  it("decodes to the requested byte length and differs per call", () => {
    const a = randomToken(16);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(b64uToBytes(a).length).toBe(16);
    expect(randomToken(16)).not.toBe(a);
  });
});

describe("sha256hex", () => {
  it("hashes known vector", async () => {
    expect(await sha256hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("pin hashing", () => {
  it("verifies correct and rejects wrong pin", async () => {
    const { hash, salt } = await hashPin("123456");
    expect(await verifyPin("123456", hash, salt)).toBe(true);
    expect(await verifyPin("123457", hash, salt)).toBe(false);
  });
  it("uses a fresh salt each time", async () => {
    const a = await hashPin("123456");
    const b = await hashPin("123456");
    expect(a.salt).not.toBe(b.salt);
  });
});

describe("encryptJson/decryptJson", () => {
  it("round-trips unicode", async () => {
    const k = keyB64(1);
    const { iv, blob } = await encryptJson({ a: "ă" }, k);
    expect(await decryptJson(iv, blob, k)).toEqual({ a: "ă" });
  });
  it("rejects with another key", async () => {
    const { iv, blob } = await encryptJson({ a: 1 }, keyB64(1));
    await expect(decryptJson(iv, blob, keyB64(2))).rejects.toThrow();
  });
  it("uses a fresh iv each time", async () => {
    const k = keyB64(1);
    const a = await encryptJson({ a: 1 }, k);
    const b = await encryptJson({ a: 1 }, k);
    expect(a.iv).not.toBe(b.iv);
  });
});

describe("verifySignature", () => {
  const sign = async (priv, data) => {
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(data)));
    return bytesToB64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  it("accepts valid, rejects other data and garbage", async () => {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const sig = await sign(kp.privateKey, "nonce");
    expect(await verifySignature(jwk, "nonce", sig)).toBe(true);
    expect(await verifySignature(jwk, "other", sig)).toBe(false);
    expect(await verifySignature(jwk, "nonce", "!!garbage!!")).toBe(false);
    expect(await verifySignature({ bogus: 1 }, "nonce", sig)).toBe(false);
  });
});

describe("safeEqual", () => {
  it("compares strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
