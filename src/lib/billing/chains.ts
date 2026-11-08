/** EVM networks that can take USDT and USDC (D352). Confirmations live here. */

export const BILLING_CHAINS = [
  { id: "ethereum", chainId: 1, confirmations: 12 },
  { id: "polygon", chainId: 137, confirmations: 64 },
  { id: "arbitrum", chainId: 42161, confirmations: 10 },
  { id: "base", chainId: 8453, confirmations: 10 },
] as const;

export type BillingChainId = (typeof BILLING_CHAINS)[number]["id"];
export type BillingToken = "USDC" | "USDT";

export function chainById(id: string) {
  return BILLING_CHAINS.find((chain) => chain.id === id) ?? null;
}

export function chainByChainId(chainId: number) {
  return BILLING_CHAINS.find((chain) => chain.chainId === chainId) ?? null;
}

/**
 * Official token contracts. Empty until the founder sets
 * BILLING_TOKEN_CONTRACTS, a JSON object of chain → token → 0x address.
 * Addresses are not written from memory.
 */
export function tokenContracts(
  raw = process.env.BILLING_TOKEN_CONTRACTS,
): Partial<Record<BillingChainId, Partial<Record<BillingToken, string>>>> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Partial<
    Record<BillingChainId, Partial<Record<BillingToken, string>>>
  >;
}

export function tokenContract(
  chain: string,
  token: string,
  table = tokenContracts(),
): string | null {
  const address = table[chain as BillingChainId]?.[token as BillingToken];
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return address.toLowerCase();
}
