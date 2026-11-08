/**
 * Receipt checks for Tron and Solana (D384). Same rules as the EVM check
 * (PAYMENTS §4.3), different receipt shapes. The unique hash is enforced by
 * the database, not here.
 */

import { TRANSFER_TOPIC, type VerifyResult } from "../verify-transfer";
import { tronFromHex } from "./base58";

const CLOCK_SKEW_SECONDS = 120;

type Common = {
  tokenContract: string;
  recipient: string;
  payer: string;
  amount: bigint;
  orderCreatedAt: number;
  sanctioned: boolean;
  confirmations: number;
  requiredConfirmations: number;
};

/** Subset of TronGrid `gettransactioninfobyid`. */
export type TronTxInfo = {
  id?: string;
  blockNumber?: number;
  blockTimeStamp?: number;
  receipt?: { result?: string };
  log?: { address: string; topics: string[]; data: string }[];
};

function finish(
  input: Common,
  value: bigint,
  blockTime: number | null,
): VerifyResult {
  if (input.sanctioned) return { ok: false, reason: "sanctioned" };
  if (value < input.amount) return { ok: false, reason: "underpaid" };
  if (
    blockTime === null ||
    blockTime < input.orderCreatedAt - CLOCK_SKEW_SECONDS
  ) {
    return { ok: false, reason: "too_old" };
  }
  if (input.confirmations < input.requiredConfirmations) {
    return { ok: false, reason: "confirmations" };
  }
  return { ok: true, value };
}

export function verifyTronTransfer(
  input: Common & { info: TronTxInfo | null },
): VerifyResult {
  const info = input.info;
  if (!info || !info.id) return { ok: false, reason: "missing" };
  if (info.receipt?.result !== "SUCCESS")
    return { ok: false, reason: "reverted" };
  const log = (info.log ?? []).find(
    (entry) =>
      tronFromHex(entry.address) === input.tokenContract &&
      `0x${(entry.topics[0] ?? "").replace(/^0x/, "").toLowerCase()}` ===
        TRANSFER_TOPIC &&
      entry.topics.length >= 3,
  );
  if (!log) return { ok: false, reason: "no_transfer" };
  if (tronFromHex(log.topics[2] ?? "") !== input.recipient) {
    return { ok: false, reason: "wrong_recipient" };
  }
  if (tronFromHex(log.topics[1] ?? "") !== input.payer) {
    return { ok: false, reason: "wrong_payer" };
  }
  const value = BigInt(`0x${log.data.replace(/^0x/, "") || "0"}`);
  const time = info.blockTimeStamp
    ? Math.floor(info.blockTimeStamp / 1000)
    : null;
  return finish(input, value, time);
}

type TokenBalance = {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
};

/** Subset of Solana `getTransaction` (jsonParsed, finalized). */
export type SolanaTx = {
  blockTime?: number | null;
  meta?: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction?: {
    message?: { accountKeys?: { pubkey: string; signer: boolean }[] };
  };
};

function balanceOf(
  rows: TokenBalance[] | undefined,
  mint: string,
  owner: string,
): bigint {
  return (rows ?? [])
    .filter((row) => row.mint === mint && row.owner === owner)
    .reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), BigInt(0));
}

/**
 * Solana pays into token accounts, so the check reads balance changes per
 * owner for the one mint: the recipient's grows, the payer's shrinks, and the
 * payer signed the transaction.
 */
export function verifySolanaTransfer(
  input: Common & { tx: SolanaTx | null },
): VerifyResult {
  const tx = input.tx;
  if (!tx?.meta) return { ok: false, reason: "missing" };
  if (tx.meta.err !== null && tx.meta.err !== undefined) {
    return { ok: false, reason: "reverted" };
  }
  const mint = input.tokenContract;
  const touched = [
    ...(tx.meta.preTokenBalances ?? []),
    ...(tx.meta.postTokenBalances ?? []),
  ];
  if (!touched.some((row) => row.mint === mint))
    return { ok: false, reason: "no_transfer" };

  const received =
    balanceOf(tx.meta.postTokenBalances, mint, input.recipient) -
    balanceOf(tx.meta.preTokenBalances, mint, input.recipient);
  if (received <= BigInt(0)) return { ok: false, reason: "wrong_recipient" };

  const spent =
    balanceOf(tx.meta.preTokenBalances, mint, input.payer) -
    balanceOf(tx.meta.postTokenBalances, mint, input.payer);
  const signed = (tx.transaction?.message?.accountKeys ?? []).some(
    (key) => key.pubkey === input.payer && key.signer,
  );
  if (!signed || spent < received) return { ok: false, reason: "wrong_payer" };

  return finish(input, received, tx.blockTime ?? null);
}
