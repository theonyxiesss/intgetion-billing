"use client";

import { useEffect, useRef, useState } from "react";
import { Button, TokenMark, cn } from "@/components/ui";
import { connectWallet, type WalletRoute } from "./connect-wallet";
import { classifyPayError, type PayErrorKind } from "./pay-error";

/** Texts from `freelance.pay`, built on the server (they do not ship globally). */
export type FreelancePayCopy = Record<string, string>;

type Payment = {
  id: string;
  status: string;
  chainId: number;
  token: string;
  tokenContract: string;
  recipient: string;
  tokenAmount: string;
};

type Provider = Awaited<ReturnType<typeof connectWallet>>;

function transferData(to: string, amount: bigint): `0x${string}` {
  const address = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const value = amount.toString(16).padStart(64, "0");
  return `0x${"a9059cbb"}${address}${value}`;
}

function units(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole + frac.padEnd(6, "0").slice(0, 6));
}

async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code ?? "";
  } catch {
    return "";
  }
}

async function signIn(provider: Provider): Promise<string> {
  const accounts = (await provider.request({
    method: "eth_accounts",
  })) as string[];
  const chainId = Number(
    (await provider.request({ method: "eth_chainId" })) as string,
  );
  const address = accounts[0];
  if (!address) throw new Error("wallet");
  const nonce = await fetch("/api/billing/crypto/siwe/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, chainId }),
  });
  if (!nonce.ok) {
    throw new Error(
      (await errorCode(nonce)) === "VALIDATION_ERROR" ? "network" : "nonce",
    );
  }
  const { message } = (await nonce.json()) as { message: string };
  const signature = (await provider.request({
    method: "personal_sign",
    params: [message, address],
  })) as string;
  const verified = await fetch("/api/billing/crypto/siwe/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signature }),
  });
  if (!verified.ok) throw new Error("verify");
  return address;
}

/**
 * Paying a freelance order (28.6, D463): the same wallet steps as the
 * checkout, but the money goes to the freelancer's proven address and the
 * amount is the order's price. The server alone decides that it is paid.
 */
export function FreelancePay({
  orderId,
  title,
  amount,
  projectId,
  copy,
  createUrl,
  paymentsBase = "/api/freelance/payments",
}: {
  orderId: string;
  title: string;
  amount: string;
  projectId: string;
  copy: FreelancePayCopy;
  /** Where the payment is opened. A UGC brief budget passes its own (D466). */
  createUrl?: string;
  paymentsBase?: string;
}) {
  const [token, setToken] = useState<"USDC" | "USDT">("USDC");
  const [payment, setPayment] = useState<Payment | null>(null);
  const [error, setError] = useState<PayErrorKind | "unavailable" | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (poll.current !== null) window.clearInterval(poll.current);
    },
    [],
  );

  async function pay(route: WalletRoute) {
    setBusy(true);
    setError(null);
    try {
      const provider = await connectWallet(projectId, route);
      const address = await signIn(provider);
      const created = await fetch(
        createUrl ?? `/api/freelance/orders/${orderId}/payment`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
      );
      if (!created.ok) {
        const code = await errorCode(created);
        if (code === "TOKEN_UNSUPPORTED") throw new Error("token");
        if (code === "CHAIN_UNSUPPORTED") throw new Error("network");
        if (
          code === "PAYOUT_WALLET_REQUIRED" ||
          code === "PAYOUT_UNDER_REVIEW" ||
          code === "BILLING_UNAVAILABLE"
        ) {
          setError("unavailable");
          return;
        }
        throw new Error("order");
      }
      const next = (await created.json()) as Payment;
      setPayment(next);
      if (next.status === "paid") return;
      const hash = (await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: address,
            to: next.tokenContract,
            data: transferData(next.recipient, units(next.tokenAmount)),
          },
        ],
      })) as string;
      const confirmed = await fetch(`${paymentsBase}/${next.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash: hash }),
      });
      if (!confirmed.ok) throw new Error("confirm");
      setPayment((await confirmed.json()) as Payment);
      if (poll.current !== null) window.clearInterval(poll.current);
      poll.current = window.setInterval(async () => {
        const fresh = await fetch(`${paymentsBase}/${next.id}`);
        if (!fresh.ok) return;
        const body = (await fresh.json()) as Payment;
        setPayment(body);
        if (body.status !== "awaiting_payment" && body.status !== "checking") {
          if (poll.current !== null) window.clearInterval(poll.current);
          poll.current = null;
        }
      }, 4000);
    } catch (caught) {
      setError(classifyPayError(caught));
    } finally {
      setBusy(false);
    }
  }

  const hold =
    busy || payment?.status === "checking" || payment?.status === "paid";
  const shown: "USDC" | "USDT" =
    payment?.token === "USDT" || payment?.token === "USDC"
      ? payment.token
      : token;

  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-6 border border-line bg-surface p-6">
      <header className="flex flex-col gap-2">
        <p className="t-label text-fg-muted">{copy.payFor}</p>
        <h2 className="t-h2">{title}</h2>
        <p className="t-data-l">{amount}</p>
        <p className="t-body-s text-fg-muted">{copy.direct}</p>
      </header>
      <div
        role="radiogroup"
        aria-label={copy.token}
        className="grid grid-cols-2 gap-3"
      >
        {(["USDC", "USDT"] as const).map((code) => (
          <button
            key={code}
            type="button"
            role="radio"
            aria-checked={token === code}
            disabled={hold}
            onClick={() => setToken(code)}
            className={cn(
              "flex min-h-20 items-center gap-3 border px-3 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              token === code
                ? "border-fg bg-surface-2"
                : "border-line hover:border-line-strong",
            )}
          >
            <TokenMark token={code} />
            <span className="t-label">{code}</span>
          </button>
        ))}
      </div>
      <Button
        type="button"
        size="lg"
        className="w-full"
        onClick={() => pay("browser")}
        loading={busy}
        disabled={hold}
      >
        {copy.payNow}
      </Button>
      {projectId ? (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => pay("qr")}
          disabled={hold}
        >
          {copy.payQr}
        </Button>
      ) : null}
      {payment ? (
        <div className="flex flex-col gap-3 border border-line bg-bg p-4">
          <p
            className={cn(
              "t-body-s",
              payment.status === "paid" && "text-success",
              (payment.status === "failed" || payment.status === "expired") &&
                "text-danger",
            )}
          >
            {copy[`status_${payment.status}`] ?? copy.status_checking}
          </p>
          <p className="flex items-center gap-3">
            <TokenMark token={shown} />
            <span className="t-h3">
              {payment.tokenAmount} {payment.token}
            </span>
          </p>
          <p className="t-caption text-fg-muted">{copy.checkWallet}</p>
          <p className="font-mono text-sm break-all">{payment.recipient}</p>
        </div>
      ) : null}
      {error ? (
        <p
          className={
            error === "cancel"
              ? "t-body-s text-fg-muted"
              : "t-body-s text-danger"
          }
        >
          {copy[`error_${error}`] ?? copy.error_failed}
        </p>
      ) : null}
    </section>
  );
}
