import type { SolanaTx, TronTxInfo } from "./verify-receipt";

const TRON_DEFAULT = "https://api.trongrid.io";
const SOLANA_DEFAULT = "https://api.mainnet-beta.solana.com";

function endpoint(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`rpc ${response.status}`);
  return response.json();
}

/** Reads a Tron receipt with our own request. A missing one is not a failure yet. */
export async function readTron(
  txId: string,
): Promise<{ info: TronTxInfo | null; confirmations: number }> {
  const base = endpoint("RPC_URL_TRON", TRON_DEFAULT).replace(/\/$/, "");
  try {
    const info = (await postJson(`${base}/wallet/gettransactioninfobyid`, {
      value: txId,
    })) as TronTxInfo;
    if (!info?.id || !info.blockNumber) return { info: null, confirmations: 0 };
    const head = (await postJson(`${base}/wallet/getnowblock`, {})) as {
      block_header?: { raw_data?: { number?: number } };
    };
    const top = head.block_header?.raw_data?.number ?? 0;
    return { info, confirmations: Math.max(0, top - info.blockNumber + 1) };
  } catch {
    return { info: null, confirmations: 0 };
  }
}

/** Reads a finalized Solana transaction; finalized counts as confirmed. */
export async function readSolana(
  signature: string,
): Promise<{ tx: SolanaTx | null; confirmations: number }> {
  try {
    const body = (await postJson(endpoint("RPC_URL_SOLANA", SOLANA_DEFAULT), {
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        {
          commitment: "finalized",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        },
      ],
    })) as { result?: SolanaTx | null };
    const tx = body.result ?? null;
    return { tx, confirmations: tx ? 1 : 0 };
  } catch {
    return { tx: null, confirmations: 0 };
  }
}
