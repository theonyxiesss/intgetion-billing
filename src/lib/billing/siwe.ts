import { isAddress, recoverMessageAddress } from "viem";
import { siteUrl } from "@intgetion/kit";

export function siweMessage(input: {
  address: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  /** What the signature is for; the checkout keeps its own line. */
  statement?: string;
}): string {
  const uri = siteUrl();
  const domain = new URL(uri).host;
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    input.address,
    "",
    input.statement ?? "Pay for INTGETION JOB LIST.",
    "",
    `URI: ${uri}`,
    "Version: 1",
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expirationTime}`,
  ].join("\n");
}

export async function recoverSiweAddress(
  message: string,
  signature: `0x${string}`,
): Promise<string | null> {
  try {
    const address = await recoverMessageAddress({ message, signature });
    return address.toLowerCase();
  } catch {
    return null;
  }
}

export function validAddress(value: string): `0x${string}` | null {
  return isAddress(value) ? value : null;
}
