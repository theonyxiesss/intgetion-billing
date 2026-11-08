import { createPublicClient, http, type Chain } from "viem";
import { arbitrum, base, mainnet, polygon } from "viem/chains";
import { chainById, type BillingChainId } from "./chains";
import type { TransferReceipt } from "./verify-transfer";

const CHAINS: Record<BillingChainId, Chain> = {
  ethereum: mainnet,
  polygon,
  arbitrum,
  base,
};

function rpcUrl(chain: BillingChainId): string | null {
  const name = `RPC_URL_${chain.toUpperCase()}`;
  const value = process.env[name]?.trim();
  return value || null;
}

export type ChainSnapshot = {
  receipt: TransferReceipt | null;
  blockTimestamp: number | null;
  confirmations: number;
};

/** Reads a receipt with our own RPC. A missing transaction is not a failure yet. */
export async function readChain(
  chainId: string,
  hash: `0x${string}`,
): Promise<ChainSnapshot> {
  const chain = chainById(chainId);
  if (!chain) return { receipt: null, blockTimestamp: null, confirmations: 0 };
  const url = rpcUrl(chain.id);
  if (!url) return { receipt: null, blockTimestamp: null, confirmations: 0 };
  const client = createPublicClient({
    chain: CHAINS[chain.id],
    transport: http(url),
  });
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const head = await client.getBlockNumber();
    const confirmations = Number(head - receipt.blockNumber) + 1;
    return {
      receipt: {
        status: receipt.status,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics.map(String),
          data: log.data,
        })),
      },
      blockTimestamp: Number(block.timestamp),
      confirmations,
    };
  } catch {
    return { receipt: null, blockTimestamp: null, confirmations: 0 };
  }
}
