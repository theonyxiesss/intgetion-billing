"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { planLoginNext } from "@/components/auth/login-next";
import { Button, TokenMark, cn } from "@/components/ui";
import { useRouter } from "@/i18n/navigation";
import {
  connectWallet,
  findBrowserWallet,
  inWalletApp,
  phoneLayout,
  type WalletRoute,
} from "./connect-wallet";
import { NonEvmPay, type NonEvmOption } from "./non-evm-pay";
import { classifyPayError, type PayErrorKind } from "./pay-error";

type Order = {
  id: string;
  status: string;
  plan: "start" | "hire" | "team" | "plus" | "pro";
  chainId: number;
  token: string;
  tokenContract: string;
  recipient: string;
  tokenAmount: string;
};

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

export function CryptoPay({
  plan,
  amount,
  jobId,
  companyId,
  projectId,
  evm = true,
  networks = [],
}: {
  plan: "hire" | "team" | "plus" | "pro";
  amount: string;
  jobId?: string;
  companyId?: string;
  projectId: string;
  evm?: boolean;
  networks?: NonEvmOption[];
}) {
  const t = useTranslations("billing");
  const router = useRouter();
  const [token, setToken] = useState<"USDC" | "USDT">("USDC");
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<PayErrorKind | null>(null);
  const [busy, setBusy] = useState(false);
  // With an extension the pay button opens it; the QR is a second choice (D422).
  // On the phone layout the pay button itself opens WalletConnect (D425).
  const [hasBrowserWallet, setHasBrowserWallet] = useState(false);
  const [walletConnectFirst, setWalletConnectFirst] = useState(false);
  const poll = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    void findBrowserWallet().then((wallet) => {
      if (live) setHasBrowserWallet(wallet !== null);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setWalletConnectFirst(phoneLayout() && !inWalletApp());
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(
    () => () => {
      if (poll.current !== null) window.clearInterval(poll.current);
    },
    [],
  );

  async function pay(route: WalletRoute) {
    setBusy(true);
    setError(null);
    const returnTo = planLoginNext(plan) ?? "billing";
    const requireSession = (response: Response) => {
      if (response.status !== 401) return;
      router.push(`/login?next=${returnTo}`);
      throw new Error("auth");
    };
    try {
      const provider = await connectWallet(projectId, route);
      const accounts = (await provider.request({
        method: "eth_accounts",
      })) as string[];
      const chainHex = (await provider.request({
        method: "eth_chainId",
      })) as string;
      const address = accounts[0];
      const chainId = Number(chainHex);
      if (!address) throw new Error("wallet");
      const nonce = await fetch("/api/billing/crypto/siwe/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, chainId }),
      });
      requireSession(nonce);
      if (!nonce.ok) {
        const code = await errorCode(nonce);
        throw new Error(code === "VALIDATION_ERROR" ? "network" : "nonce");
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
      requireSession(verified);
      if (!verified.ok) throw new Error("verify");
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
      requireSession(created);
      if (!created.ok) {
        const code = await errorCode(created);
        if (code === "TOKEN_UNSUPPORTED") throw new Error("token");
        if (code === "CHAIN_UNSUPPORTED") throw new Error("network");
        throw new Error("order");
      }
      const next = (await created.json()) as Order;
      setOrder(next);
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
      const confirmed = await fetch("/api/billing/crypto/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: next.id, txHash: hash }),
      });
      requireSession(confirmed);
      if (!confirmed.ok) throw new Error("confirm");
      setOrder((await confirmed.json()) as Order);
      if (poll.current !== null) window.clearInterval(poll.current);
      poll.current = window.setInterval(async () => {
        const fresh = await fetch(`/api/billing/crypto/orders/${next.id}`);
        if (fresh.status === 401) {
          if (poll.current !== null) window.clearInterval(poll.current);
          poll.current = null;
          router.push(`/login?next=${returnTo}`);
          return;
        }
        if (!fresh.ok) return;
        const body = (await fresh.json()) as Order;
        setOrder(body);
        if (body.status !== "awaiting_payment" && body.status !== "checking") {
          if (poll.current !== null) window.clearInterval(poll.current);
          poll.current = null;
        }
      }, 4000);
    } catch (caught) {
      if (caught instanceof Error && caught.message === "auth") return;
      setError(classifyPayError(caught));
    } finally {
      setBusy(false);
    }
  }

  const hold = busy || order?.status === "checking" || order?.status === "paid";
  const shownToken: "USDC" | "USDT" =
    order?.token === "USDC" || order?.token === "USDT" ? order.token : token;

  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-6 border border-line bg-surface p-6">
      <header className="flex flex-col gap-2">
        <p className="t-label text-fg-muted">{t("payFor")}</p>
        <h2 className="t-h2">{t(`planName.${plan}`)}</h2>
        <p className="t-data-l">${amount}</p>
        <p className="t-body-s text-fg-muted">{t("forDays")}</p>
      </header>
      {evm ? (
        <>
          <div
            role="radiogroup"
            aria-label={t("token")}
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
                <span className="flex flex-col">
                  <span className="t-body-s">
                    {code === "USDC" ? t("usdCoin") : t("tether")}
                  </span>
                  <span className="t-label text-fg-muted">{code}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="t-caption text-fg-muted">{t("baseNote")}</p>
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={() => pay("browser")}
            loading={busy}
            disabled={hold}
          >
            {t("payNow", { amount, token: shownToken })}
          </Button>
          {projectId && hasBrowserWallet && !walletConnectFirst ? (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => pay("qr")}
              disabled={hold}
            >
              {t("payQr")}
            </Button>
          ) : null}
          {order ? (
            <div className="flex flex-col gap-3 border border-line bg-bg p-4">
              <p
                className={cn(
                  "t-body-s",
                  order.status === "paid" && "text-success",
                  (order.status === "failed" ||
                    order.status === "underpaid" ||
                    order.status === "expired") &&
                    "text-danger",
                )}
              >
                {t(`status.${order.status as "paid"}`)}
              </p>
              <p className="flex items-center gap-3">
                <TokenMark token={shownToken} />
                <span className="t-h3">
                  {order.tokenAmount} {order.token}
                </span>
              </p>
              <p className="t-caption text-fg-muted">{t("checkWallet")}</p>
              <p className="font-mono text-sm break-all">{order.recipient}</p>
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
              {error === "wallet"
                ? t("needWallet")
                : error === "cancel"
                  ? t("cancelled")
                  : error === "network"
                    ? t("network")
                    : error === "token"
                      ? t("tokenUnsupported")
                      : t("status.failed")}
            </p>
          ) : null}
        </>
      ) : null}
      {networks.length > 0 ? (
        <NonEvmPay
          plan={plan}
          jobId={jobId}
          companyId={companyId}
          networks={networks}
        />
      ) : null}
    </section>
  );
}
