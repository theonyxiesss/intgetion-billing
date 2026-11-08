/**
 * One transfer is real only when every check passes (PAYMENTS §4.3).
 * The unique hash is enforced by the database, not here.
 */

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type TransferLog = {
  address: string;
  topics: string[];
  data: string;
};

export type TransferReceipt = {
  status: string | number;
  logs: TransferLog[];
};

export type VerifyFailure =
  | "missing"
  | "reverted"
  | "no_transfer"
  | "wrong_recipient"
  | "wrong_payer"
  | "sanctioned"
  | "underpaid"
  | "too_old"
  | "confirmations";

export type VerifyResult =
  { ok: true; value: bigint } | { ok: false; reason: VerifyFailure };

export type VerifyInput = {
  receipt: TransferReceipt | null;
  blockTimestamp: number | null;
  confirmations: number;
  requiredConfirmations: number;
  tokenContract: string;
  recipient: string;
  payer: string;
  amount: bigint;
  orderCreatedAt: number;
  sanctioned: boolean;
};

const CLOCK_SKEW_SECONDS = 120;

function addressOf(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function succeeded(status: string | number): boolean {
  return status === 1 || status === "0x1" || status === "1";
}

export function verifyTransfer(input: VerifyInput): VerifyResult {
  if (!input.receipt) return { ok: false, reason: "missing" };
  if (!succeeded(input.receipt.status))
    return { ok: false, reason: "reverted" };

  const wanted = input.tokenContract.toLowerCase();
  const log = input.receipt.logs.find(
    (entry) =>
      entry.address.toLowerCase() === wanted &&
      entry.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      entry.topics.length >= 3,
  );
  if (!log) return { ok: false, reason: "no_transfer" };

  const to = addressOf(log.topics[2] ?? "");
  if (to !== input.recipient.toLowerCase()) {
    return { ok: false, reason: "wrong_recipient" };
  }
  const from = addressOf(log.topics[1] ?? "");
  if (from !== input.payer.toLowerCase()) {
    return { ok: false, reason: "wrong_payer" };
  }
  if (input.sanctioned) return { ok: false, reason: "sanctioned" };

  const value = BigInt(log.data);
  if (value < input.amount) return { ok: false, reason: "underpaid" };

  if (
    input.blockTimestamp === null ||
    input.blockTimestamp < input.orderCreatedAt - CLOCK_SKEW_SECONDS
  ) {
    return { ok: false, reason: "too_old" };
  }
  if (input.confirmations < input.requiredConfirmations) {
    return { ok: false, reason: "confirmations" };
  }
  return { ok: true, value };
}

/** USD cents to a 6-decimal stablecoin amount. */
export function tokenUnits(amountMinor: bigint): bigint {
  return amountMinor * BigInt(10000);
}
