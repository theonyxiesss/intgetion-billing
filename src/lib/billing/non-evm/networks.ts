/**
 * Tron and Solana (D384). They do not take the EVM `0x` address and do not
 * use the EVM receipt check: each network has its own recipient variable and
 * its own receipt reader.
 *
 * Token contracts were copied from the issuers' pages and cross-checked on
 * 2026-10-11:
 * - USDT: https://tether.to/en/supported-protocols
 *   Tron checked with apilist.tronscanapi.com (symbol USDT, 6 decimals,
 *   "official stablecoin issued by Tether"); Solana mint checked with
 *   getAccountInfo on mainnet-beta (SPL Token, 6 decimals).
 * - USDC: https://developers.circle.com/stablecoins/usdc-contract-addresses
 *   Solana mint checked with getAccountInfo (SPL Token, 6 decimals). Circle
 *   lists no mainnet USDC on Tron, so Tron + USDC is not offered.
 * A token with the same name and another contract never counts.
 */

import { isBase58Address, isTronAddress } from "./base58";

export const NON_EVM_NETWORKS = [
  {
    id: "tron",
    // Tron's own chain id; stored in billing_wallet_sessions.chain_id.
    chainId: 728126428,
    // About one minute of blocks; Tron solidifies after 19.
    confirmations: 20,
    recipientEnv: "COMPANY_WALLET_TRON",
    tokens: { USDT: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
  },
  {
    id: "solana",
    // Solana has no chain id. A negative number never clashes with EVM.
    chainId: -501,
    // The reader asks for "finalized" transactions only.
    confirmations: 1,
    recipientEnv: "COMPANY_WALLET_SOLANA",
    tokens: {
      USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    },
  },
] as const;

export type NonEvmNetworkId = (typeof NON_EVM_NETWORKS)[number]["id"];

export function nonEvmNetwork(id: string) {
  return NON_EVM_NETWORKS.find((network) => network.id === id) ?? null;
}

export function nonEvmByChainId(chainId: number) {
  return (
    NON_EVM_NETWORKS.find((network) => network.chainId === chainId) ?? null
  );
}

export function nonEvmToken(network: string, token: string): string | null {
  const found = nonEvmNetwork(network);
  if (!found) return null;
  return (found.tokens as Partial<Record<string, string>>)[token] ?? null;
}

export function validNonEvmAddress(network: string, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("0x")) return false;
  if (network === "tron") return isTronAddress(trimmed);
  if (network === "solana") return isBase58Address(trimmed, 32);
  return false;
}

/** Recipient from the environment. A `0x` address or a typo is no recipient. */
export function nonEvmRecipient(
  network: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const found = nonEvmNetwork(network);
  if (!found) return null;
  const value = env[found.recipientEnv]?.trim() ?? "";
  return validNonEvmAddress(found.id, value) ? value : null;
}

/** Checkout offers EVM only until the founder turns Solana and Tron back on. */
const NON_EVM_CHECKOUT = false;

/** Networks whose button may promise payment: billing on and a recipient set. */
export function readyNonEvmNetworks(
  env: Record<string, string | undefined> = process.env,
): NonEvmNetworkId[] {
  if (!NON_EVM_CHECKOUT) return [];
  if (env.BILLING_ENABLED !== "true") return [];
  return NON_EVM_NETWORKS.filter((network) =>
    nonEvmRecipient(network.id, env),
  ).map((network) => network.id);
}

export function validTxId(network: string, value: string): boolean {
  if (network === "tron") return /^[0-9a-fA-F]{64}$/.test(value);
  if (network === "solana") return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value);
  return false;
}
