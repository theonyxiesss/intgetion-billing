import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount, serializeSignature, sign } from "viem/accounts";
import { settlement } from "../status";
import { TRANSFER_TOPIC } from "../verify-transfer";
import {
  base58Decode,
  base58Encode,
  isTronAddress,
  tronFromHex,
} from "./base58";
import {
  nonEvmRecipient,
  nonEvmToken,
  readyNonEvmNetworks,
  validTxId,
} from "./networks";
import {
  tronMessageHash,
  verifySolanaSignature,
  verifyTronSignature,
} from "./signature";
import {
  verifySolanaTransfer,
  verifyTronTransfer,
  type SolanaTx,
  type TronTxInfo,
} from "./verify-receipt";

// Fixture addresses only: none of them is a company wallet.
const hex20 = (byte: string) => byte.repeat(20);
const TRON_RECIPIENT = tronFromHex(hex20("11")) as string;
const TRON_PAYER = tronFromHex(hex20("22")) as string;
const TRON_STRANGER = tronFromHex(hex20("33")) as string;
const TRON_USDT = nonEvmToken("tron", "USDT") as string;
const TRON_FAKE_USDT = tronFromHex(hex20("44")) as string;

const SOL_RECIPIENT = base58Encode(new Uint8Array(32).fill(5));
const SOL_PAYER = base58Encode(new Uint8Array(32).fill(6));
const SOL_STRANGER = base58Encode(new Uint8Array(32).fill(7));
const SOL_USDC = nonEvmToken("solana", "USDC") as string;
const SOL_FAKE_USDC = base58Encode(new Uint8Array(32).fill(8));

const AMOUNT = BigInt(79_000_000);
const CREATED = 1_800_000_000;

function tronHex(address: string): string {
  return Buffer.from(
    (base58Decode(address) as Uint8Array).subarray(1, 21),
  ).toString("hex");
}

function tronInfo(over: {
  contract?: string;
  from?: string;
  to?: string;
  value?: bigint;
  result?: string;
}): TronTxInfo {
  const pad = (body: string) => body.padStart(64, "0");
  return {
    id: "ab".repeat(32),
    blockNumber: 100,
    blockTimeStamp: (CREATED + 30) * 1000,
    receipt: { result: over.result ?? "SUCCESS" },
    log: [
      {
        address: tronHex(over.contract ?? TRON_USDT),
        topics: [
          TRANSFER_TOPIC.slice(2),
          pad(tronHex(over.from ?? TRON_PAYER)),
          pad(tronHex(over.to ?? TRON_RECIPIENT)),
        ],
        data: pad((over.value ?? AMOUNT).toString(16)),
      },
    ],
  };
}

const tronBase = {
  tokenContract: TRON_USDT,
  recipient: TRON_RECIPIENT,
  payer: TRON_PAYER,
  amount: AMOUNT,
  orderCreatedAt: CREATED,
  sanctioned: false,
  confirmations: 20,
  requiredConfirmations: 20,
};

function solanaTx(over: {
  mint?: string;
  from?: string;
  to?: string;
  value?: bigint;
  err?: unknown;
  signer?: string;
}): SolanaTx {
  const mint = over.mint ?? SOL_USDC;
  const from = over.from ?? SOL_PAYER;
  const to = over.to ?? SOL_RECIPIENT;
  const value = over.value ?? AMOUNT;
  const row = (owner: string, amount: bigint) => ({
    mint,
    owner,
    uiTokenAmount: { amount: amount.toString() },
  });
  return {
    blockTime: CREATED + 30,
    meta: {
      err: over.err ?? null,
      preTokenBalances: [row(from, BigInt(500_000_000)), row(to, BigInt(0))],
      postTokenBalances: [
        row(from, BigInt(500_000_000) - value),
        row(to, value),
      ],
    },
    transaction: {
      message: { accountKeys: [{ pubkey: over.signer ?? from, signer: true }] },
    },
  };
}

const solBase = {
  tokenContract: SOL_USDC,
  recipient: SOL_RECIPIENT,
  payer: SOL_PAYER,
  amount: AMOUNT,
  orderCreatedAt: CREATED,
  sanctioned: false,
  confirmations: 1,
  requiredConfirmations: 1,
};

describe("D384 networks", () => {
  it("offers only official issuer contracts and no Tron USDC", () => {
    expect(TRON_USDT).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
    expect(isTronAddress(TRON_USDT)).toBe(true);
    expect(nonEvmToken("tron", "USDC")).toBeNull();
    expect(nonEvmToken("solana", "USDT")).toBe(
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    );
  });

  it("reads one recipient per network and rejects a 0x address", () => {
    const env = {
      BILLING_ENABLED: "true",
      COMPANY_WALLET_TRON: "0x1111111111111111111111111111111111111111",
      COMPANY_WALLET_SOLANA: SOL_RECIPIENT,
      COMPANY_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
    };
    expect(nonEvmRecipient("tron", env)).toBeNull();
    expect(nonEvmRecipient("solana", env)).toBe(SOL_RECIPIENT);
    expect(readyNonEvmNetworks(env)).toEqual([]);
  });

  it("does not offer Solana or Tron while checkout is EVM only", () => {
    expect(
      readyNonEvmNetworks({
        BILLING_ENABLED: "true",
        COMPANY_WALLET_TRON: TRON_RECIPIENT,
        COMPANY_WALLET_SOLANA: SOL_RECIPIENT,
      }),
    ).toEqual([]);
  });

  it("does not promise a network while its variable is empty", () => {
    expect(readyNonEvmNetworks({ BILLING_ENABLED: "true" })).toEqual([]);
    expect(
      readyNonEvmNetworks({
        BILLING_ENABLED: "false",
        COMPANY_WALLET_TRON: TRON_RECIPIENT,
      }),
    ).toEqual([]);
  });

  it("accepts each network's transaction id format only", () => {
    expect(validTxId("tron", "ab".repeat(32))).toBe(true);
    expect(validTxId("tron", `0x${"ab".repeat(32)}`)).toBe(false);
    expect(validTxId("solana", "5".repeat(88))).toBe(true);
    expect(validTxId("solana", "0".repeat(88))).toBe(false);
  });
});

describe("D384 sender signature", () => {
  it("proves a Tron wallet by signMessageV2", async () => {
    const key = `0x${"7".repeat(64)}` as const;
    const address = tronFromHex(privateKeyToAccount(key).address) as string;
    const message = "prove me";
    const signature = serializeSignature(
      await sign({ hash: tronMessageHash(message), privateKey: key }),
    );
    expect(await verifyTronSignature(message, signature, address)).toBe(true);
    expect(await verifyTronSignature(message, signature, TRON_PAYER)).toBe(
      false,
    );
    expect(await verifyTronSignature("other", signature, address)).toBe(false);
  });

  it("proves a Solana wallet by ed25519 signMessage", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const address = base58Encode(raw);
    const message = "prove me";
    const signature = edSign(null, Buffer.from(message), privateKey).toString(
      "base64",
    );
    expect(verifySolanaSignature(message, signature, address)).toBe(true);
    expect(verifySolanaSignature(message, signature, SOL_PAYER)).toBe(false);
    expect(verifySolanaSignature("other", signature, address)).toBe(false);
  });
});

describe("D384 Tron receipt", () => {
  const check = (
    info: TronTxInfo | null,
    over: Partial<typeof tronBase> = {},
  ) => verifyTronTransfer({ ...tronBase, ...over, info });

  it("grants a correct transfer", () => {
    const result = check(tronInfo({}));
    expect(result).toEqual({ ok: true, value: AMOUNT });
    expect(settlement(result).grant).toBe(true);
  });

  it.each([
    [
      "foreign recipient",
      tronInfo({ to: TRON_STRANGER }),
      {},
      "wrong_recipient",
      "failed",
    ],
    [
      "foreign sender",
      tronInfo({ from: TRON_STRANGER }),
      {},
      "wrong_payer",
      "failed",
    ],
    [
      "foreign contract",
      tronInfo({ contract: TRON_FAKE_USDT }),
      {},
      "no_transfer",
      "failed",
    ],
    [
      "underpaid",
      tronInfo({ value: AMOUNT - BigInt(1) }),
      {},
      "underpaid",
      "submitted",
    ],
    ["reverted", tronInfo({ result: "REVERT" }), {}, "reverted", "failed"],
    [
      "sanctioned sender",
      tronInfo({}),
      { sanctioned: true },
      "sanctioned",
      "frozen",
    ],
    [
      "too few blocks",
      tronInfo({}),
      { confirmations: 3 },
      "confirmations",
      "submitted",
    ],
  ] as const)("does not grant: %s", (_name, info, over, reason, status) => {
    const result = check(info, over);
    expect(result).toEqual({ ok: false, reason });
    const next = settlement(result);
    expect(next.grant).toBe(false);
    expect(next.status).toBe(status);
  });
});

describe("D384 Solana receipt", () => {
  const check = (tx: SolanaTx | null, over: Partial<typeof solBase> = {}) =>
    verifySolanaTransfer({ ...solBase, ...over, tx });

  it("grants a correct transfer", () => {
    const result = check(solanaTx({}));
    expect(result).toEqual({ ok: true, value: AMOUNT });
    expect(settlement(result).grant).toBe(true);
  });

  it.each([
    [
      "foreign recipient",
      solanaTx({ to: SOL_STRANGER }),
      {},
      "wrong_recipient",
      "failed",
    ],
    [
      "foreign sender",
      solanaTx({ from: SOL_STRANGER, signer: SOL_STRANGER }),
      {},
      "wrong_payer",
      "failed",
    ],
    [
      "payer did not sign",
      solanaTx({ signer: SOL_STRANGER }),
      {},
      "wrong_payer",
      "failed",
    ],
    [
      "foreign mint",
      solanaTx({ mint: SOL_FAKE_USDC }),
      {},
      "no_transfer",
      "failed",
    ],
    [
      "underpaid",
      solanaTx({ value: AMOUNT - BigInt(1) }),
      {},
      "underpaid",
      "submitted",
    ],
    [
      "reverted",
      solanaTx({ err: { InstructionError: [0, "Custom"] } }),
      {},
      "reverted",
      "failed",
    ],
    [
      "sanctioned sender",
      solanaTx({}),
      { sanctioned: true },
      "sanctioned",
      "frozen",
    ],
    ["not found yet", null, {}, "missing", "submitted"],
  ] as const)("does not grant: %s", (_name, tx, over, reason, status) => {
    const result = check(tx, over);
    expect(result).toEqual({ ok: false, reason });
    const next = settlement(result);
    expect(next.grant).toBe(false);
    expect(next.status).toBe(status);
  });
});
