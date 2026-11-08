"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Button, Input, TokenMark, cn } from "@/components/ui";

export type NonEvmOption = {
  id: "tron" | "solana";
  tokens: ("USDC" | "USDT")[];
};

type Order = {
  id: string;
  status: string;
  token: string;
  recipient: string;
  tokenAmount: string;
};

type TronWindow = {
  tronWeb?: {
    defaultAddress?: { base58?: string };
    trx?: { signMessageV2?: (message: string) => Promise<string> };
  };
  tronLink?: { request?: (args: { method: string }) => Promise<unknown> };
};

type SolanaWindow = {
  solana?: {
    connect: () => Promise<{ publicKey: { toString(): string } }>;
    signMessage: (
      bytes: Uint8Array,
      display: string,
    ) => Promise<{ signature: Uint8Array }>;
  };
};

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return window.btoa(text);
}

/** The wallet only signs a text message; no wallet library is loaded. */
async function proveWallet(
  network: "tron" | "solana",
): Promise<{ address: string; sign: (message: string) => Promise<string> }> {
  if (network === "tron") {
    const w = window as Window & TronWindow;
    await w.tronLink?.request?.({ method: "tron_requestAccounts" });
    const address = w.tronWeb?.defaultAddress?.base58;
    const sign = w.tronWeb?.trx?.signMessageV2;
    if (!address || !sign) throw new Error("wallet");
    return { address, sign: (message) => sign(message) };
  }
  const solana = (window as Window & SolanaWindow).solana;
  if (!solana) throw new Error("wallet");
  const connected = await solana.connect();
  return {
    address: connected.publicKey.toString(),
    sign: async (message) => {
      const signed = await solana.signMessage(
        new TextEncoder().encode(message),
        "utf8",
      );
      return toBase64(signed.signature);
    },
  };
}

export function NonEvmPay({
  plan,
  jobId,
  companyId,
  networks,
}: {
  plan: "hire" | "team" | "plus" | "pro";
  jobId?: string;
  companyId?: string;
  networks: NonEvmOption[];
}) {
  const t = useTranslations("billing.nonEvm");
  const tb = useTranslations("billing");
  const [network, setNetwork] = useState(networks[0]);
  const [token, setToken] = useState<"USDC" | "USDT">(
    networks[0]?.tokens[0] ?? "USDT",
  );
  const [order, setOrder] = useState<Order | null>(null);
  const [txId, setTxId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (poll.current !== null) window.clearInterval(poll.current);
    },
    [],
  );

  if (!network) return null;

  async function start() {
    if (!network) return;
    setBusy(true);
    setError(null);
    try {
      const wallet = await proveWallet(network.id);
      const nonce = await fetch("/api/billing/crypto/siwe/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network: network.id, address: wallet.address }),
      });
      if (!nonce.ok) throw new Error("failed");
      const { message } = (await nonce.json()) as { message: string };
      const signature = await wallet.sign(message);
      const verified = await fetch("/api/billing/crypto/siwe/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature }),
      });
      if (!verified.ok) throw new Error("failed");
      const created = await fetch("/api/billing/crypto/order", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan,
          token,
          ...(jobId ? { jobId } : {}),
          ...(companyId ? { companyId } : {}),
        }),
      });
      if (!created.ok) throw new Error("failed");
      setOrder((await created.json()) as Order);
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message === "wallet"
          ? "wallet"
          : "failed",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!order) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/billing/crypto/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: order.id, txHash: txId.trim() }),
      });
      if (!response.ok) throw new Error("tx");
      setOrder((await response.json()) as Order);
      if (poll.current !== null) window.clearInterval(poll.current);
      poll.current = window.setInterval(async () => {
        const fresh = await fetch(`/api/billing/crypto/orders/${order.id}`);
        if (!fresh.ok) return;
        const body = (await fresh.json()) as Order;
        setOrder(body);
        if (body.status !== "awaiting_payment" && body.status !== "checking") {
          if (poll.current !== null) window.clearInterval(poll.current);
          poll.current = null;
        }
      }, 6000);
    } catch {
      setError("tx");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-6">
      <p className="t-label text-fg-muted">{t("title")}</p>
      <div
        role="radiogroup"
        aria-label={t("network")}
        className="grid grid-cols-2 gap-3"
      >
        {networks.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={network.id === option.id}
            disabled={busy || Boolean(order)}
            onClick={() => {
              setNetwork(option);
              setToken(option.tokens[0] ?? "USDT");
            }}
            className={cn(
              "min-h-12 border px-3 py-2 text-left disabled:opacity-60",
              network.id === option.id
                ? "border-fg bg-surface-2"
                : "border-line",
            )}
          >
            {t(`name.${option.id}`)}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label={tb("token")} className="flex gap-3">
        {network.tokens.map((code) => (
          <button
            key={code}
            type="button"
            role="radio"
            aria-checked={token === code}
            disabled={busy || Boolean(order)}
            onClick={() => setToken(code)}
            className={cn(
              "flex items-center gap-2 border px-3 py-2 disabled:opacity-60",
              token === code ? "border-fg bg-surface-2" : "border-line",
            )}
          >
            <TokenMark token={code} />
            <span className="t-label">{code}</span>
          </button>
        ))}
      </div>
      {network.id === "tron" ? (
        <p className="t-caption text-fg-muted">{t("tronNote")}</p>
      ) : null}
      {!order ? (
        <Button
          type="button"
          variant="secondary"
          onClick={start}
          loading={busy}
        >
          {t("prove")}
        </Button>
      ) : (
        <div className="flex flex-col gap-3 border border-line bg-bg p-4">
          <p className="t-body-s">{tb(`status.${order.status as "paid"}`)}</p>
          <p className="t-h3">
            {order.tokenAmount} {order.token}
          </p>
          <p className="t-caption text-fg-muted">{t("sendExact")}</p>
          <p className="font-mono text-sm break-all">{order.recipient}</p>
          {order.status === "awaiting_payment" ||
          order.status === "underpaid" ? (
            <>
              <label className="t-caption text-fg-muted" htmlFor="non-evm-tx">
                {t("txLabel")}
              </label>
              <Input
                id="non-evm-tx"
                value={txId}
                onChange={(event) => setTxId(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                onClick={confirm}
                loading={busy}
                disabled={!txId.trim()}
              >
                {t("check")}
              </Button>
            </>
          ) : null}
        </div>
      )}
      {error ? (
        <p className="t-body-s text-danger">
          {error === "wallet"
            ? t(`needWallet.${network.id}`)
            : error === "tx"
              ? t("txFailed")
              : tb("status.failed")}
        </p>
      ) : null}
    </div>
  );
}
