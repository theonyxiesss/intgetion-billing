import { createHash } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(value: string): Uint8Array | null {
  if (!value || /[^1-9A-HJ-NP-Za-km-z]/.test(value)) return null;
  let number = BigInt(0);
  for (const char of value) {
    number = number * BigInt(58) + BigInt(ALPHABET.indexOf(char));
  }
  const bytes: number[] = [];
  while (number > BigInt(0)) {
    bytes.unshift(Number(number % BigInt(256)));
    number /= BigInt(256);
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let number = BigInt(0);
  for (const byte of bytes) number = number * BigInt(256) + BigInt(byte);
  let out = "";
  while (number > BigInt(0)) {
    out = ALPHABET[Number(number % BigInt(58))] + out;
    number /= BigInt(58);
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function checksum(payload: Uint8Array): Buffer {
  const once = createHash("sha256").update(payload).digest();
  return createHash("sha256").update(once).digest().subarray(0, 4);
}

export function isBase58Address(value: string, length: number): boolean {
  return base58Decode(value)?.length === length;
}

/** Tron base58check: 0x41, 20 bytes, 4 checksum bytes. */
export function isTronAddress(value: string): boolean {
  const bytes = base58Decode(value);
  if (!bytes || bytes.length !== 25 || bytes[0] !== 0x41) return false;
  return checksum(bytes.subarray(0, 21)).equals(
    Buffer.from(bytes.subarray(21)),
  );
}

/** 20-byte hex (with or without 0x / 41 prefix) to a Tron base58 address. */
export function tronFromHex(hex: string): string | null {
  const clean = hex.toLowerCase().replace(/^0x/, "");
  const body =
    clean.length === 42 && clean.startsWith("41")
      ? clean.slice(2)
      : clean.slice(-40);
  if (!/^[0-9a-f]{40}$/.test(body)) return null;
  const payload = Buffer.from(`41${body}`, "hex");
  return base58Encode(Buffer.concat([payload, checksum(payload)]));
}
