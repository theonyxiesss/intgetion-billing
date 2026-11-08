import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  stringToHex,
  toBytes,
} from "viem";

/**
 * Smart Invoice escrow (TZ 43, D562, D564): the contract for one freelance
 * order. Pure helpers only: no RPC URL, no key, no flag here. The caller
 * builds the public client and decides whether escrow is on.
 *
 * Source read in SmartInvoiceXYZ/smart-invoice (MIT): SmartInvoiceFactory.sol,
 * SmartInvoiceEscrow.sol. Factory address from its deployments/baseSepolia.json,
 * checked on chain 2026-10-27 (TZ 43 §12). Token and wrapped native token
 * addresses are not written here from memory (as chains.ts): the caller passes
 * them.
 */

export const ESCROW_NETWORKS = {
  "base-sepolia": {
    chainId: 84532,
    factory: "0x851e59a39571e599954702f0e4996bf838d9c863",
  },
} as const;

export type EscrowNetwork = keyof typeof ESCROW_NETWORKS;

/** `bytes32` invoice type of the escrow implementation in the factory. */
export const ESCROW_TYPE = stringToHex("escrow", { size: 32 });

/** ADR enum of the contract. */
export const RESOLVER_INDIVIDUAL = 0;
export const RESOLVER_ARBITRATOR = 1;

/** The contract's own limit on the locker: two years. */
export const MAX_TERMINATION_SECONDS = 63_113_904;

export const ESCROW_FACTORY_ABI = parseAbi([
  "function create(address _recipient, uint256[] _amounts, bytes _data, bytes32 _type) returns (address)",
]);

export const ESCROW_ABI = parseAbi([
  "function client() view returns (address)",
  "function provider() view returns (address)",
  "function resolverType() view returns (uint8)",
  "function resolver() view returns (address)",
  "function token() view returns (address)",
  "function terminationTime() view returns (uint256)",
  "function resolutionRate() view returns (uint256)",
  "function details() view returns (bytes32)",
  "function getAmounts() view returns (uint256[])",
  "function total() view returns (uint256)",
  "function locked() view returns (bool)",
  "function milestone() view returns (uint256)",
]);

export const ERC20_BALANCE_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

/** The order id bound into the contract; no personal data. */
export function escrowDetails(orderId: string): `0x${string}` {
  return keccak256(toBytes(`intgetion:freelance-order:${orderId}`));
}

const DATA_TYPES = [
  { type: "address" }, // client
  { type: "uint8" }, // resolverType
  { type: "address" }, // resolver
  { type: "address" }, // token
  { type: "uint256" }, // terminationTime
  { type: "bytes32" }, // details
  { type: "address" }, // wrappedNativeToken
  { type: "bool" }, // requireVerification
  { type: "address" }, // factory
] as const;

export type EscrowData = {
  client: `0x${string}`;
  resolverType: number;
  resolver: `0x${string}`;
  token: `0x${string}`;
  terminationTime: bigint;
  details: `0x${string}`;
  wrappedNativeToken: `0x${string}`;
  requireVerification: boolean;
  factory: `0x${string}`;
};

/** `_data` of `create`, in the order `_handleData` decodes it. */
export function encodeEscrowData(data: EscrowData): `0x${string}` {
  return encodeAbiParameters(DATA_TYPES, [
    data.client,
    data.resolverType,
    data.resolver,
    data.token,
    data.terminationTime,
    data.details,
    data.wrappedNativeToken,
    data.requireVerification,
    data.factory,
  ]);
}

export function decodeEscrowData(encoded: `0x${string}`): EscrowData {
  const [
    client,
    resolverType,
    resolver,
    token,
    terminationTime,
    details,
    wrappedNativeToken,
    requireVerification,
    factory,
  ] = decodeAbiParameters(DATA_TYPES, encoded);
  return {
    client,
    resolverType,
    resolver,
    token,
    terminationTime,
    details,
    wrappedNativeToken,
    requireVerification,
    factory,
  };
}

/** What the chain says about one escrow contract and its token balance. */
export type EscrowSnapshot = {
  client: string;
  provider: string;
  resolverType: number;
  resolver: string;
  token: string;
  terminationTime: bigint;
  resolutionRate: bigint;
  details: string;
  amounts: readonly bigint[];
  locked: boolean;
  milestone: bigint;
  balance: bigint;
};

/** The one call the reader needs; a viem PublicClient fits, so does a fake. */
export type ContractReader = {
  readContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
};

/** Reads the contract. Throws when the address is not an escrow (no code). */
export async function readEscrow(
  reader: ContractReader,
  address: `0x${string}`,
): Promise<EscrowSnapshot> {
  const read = (functionName: string) =>
    reader.readContract({ address, abi: ESCROW_ABI, functionName });
  const [
    client,
    provider,
    resolverType,
    resolver,
    token,
    terminationTime,
    resolutionRate,
    details,
    amounts,
    locked,
    milestone,
  ] = await Promise.all([
    read("client"),
    read("provider"),
    read("resolverType"),
    read("resolver"),
    read("token"),
    read("terminationTime"),
    read("resolutionRate"),
    read("details"),
    read("getAmounts"),
    read("locked"),
    read("milestone"),
  ]);
  const balance = await reader.readContract({
    address: String(token) as `0x${string}`,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  return {
    client: String(client).toLowerCase(),
    provider: String(provider).toLowerCase(),
    resolverType: Number(resolverType),
    resolver: String(resolver).toLowerCase(),
    token: String(token).toLowerCase(),
    terminationTime: BigInt(terminationTime as bigint),
    resolutionRate: BigInt(resolutionRate as bigint),
    details: String(details).toLowerCase(),
    amounts: (amounts as readonly bigint[]).map((value) => BigInt(value)),
    locked: Boolean(locked),
    milestone: BigInt(milestone as bigint),
    balance: BigInt(balance as bigint),
  };
}
