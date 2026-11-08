import { createPublicKey, verify } from "node:crypto";
import {
  concat,
  keccak256,
  recoverAddress,
  stringToBytes,
  toBytes,
} from "viem";
import { siteUrl } from "@intgetion/kit";
import { base58Decode, tronFromHex } from "./base58";

/** Plain text the wallet signs; the server proves the sender is the buyer. */
export function nonEvmMessage(input: {
  network: string;
  address: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}): string {
  const uri = siteUrl();
  return [
    `${new URL(uri).host} wants you to prove this ${input.network} wallet:`,
    input.address,
    "",
    "Pay for INTGETION JOB LIST.",
    "",
    `URI: ${uri}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expirationTime}`,
  ].join("\n");
}

/** TronLink signMessageV2: keccak256("\x19TRON Signed Message:\n" + len + message). */
export function tronMessageHash(message: string): `0x${string}` {
  const bytes = stringToBytes(message);
  return keccak256(
    concat([stringToBytes(`\x19TRON Signed Message:\n${bytes.length}`), bytes]),
  );
}

export async function verifyTronSignature(
  message: string,
  signature: string,
  address: string,
): Promise<boolean> {
  const hex = signature.startsWith("0x") ? signature : `0x${signature}`;
  if (!/^0x[0-9a-fA-F]{130}$/.test(hex)) return false;
  try {
    const evm = await recoverAddress({
      hash: tronMessageHash(message),
      signature: hex as `0x${string}`,
    });
    return tronFromHex(evm) === address;
  } catch {
    return false;
  }
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Phantom-style signMessage: raw ed25519 over UTF-8, signature in base64. */
export function verifySolanaSignature(
  message: string,
  signature: string,
  address: string,
): boolean {
  const publicKey = base58Decode(address);
  if (!publicKey || publicKey.length !== 32) return false;
  const raw = Buffer.from(signature, "base64");
  if (raw.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
      format: "der",
      type: "spki",
    });
    return verify(null, toBytes(message), key, raw);
  } catch {
    return false;
  }
}

export async function verifyNonEvmSignature(
  network: string,
  message: string,
  signature: string,
  address: string,
): Promise<boolean> {
  if (network === "tron")
    return verifyTronSignature(message, signature, address);
  if (network === "solana")
    return verifySolanaSignature(message, signature, address);
  return false;
}
