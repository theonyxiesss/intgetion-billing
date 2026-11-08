"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { connectWallet, type WalletRoute } from "./connect-wallet";
import { classifyPayError } from "./pay-error";

/** 0x1234…ab9f: the start and the end a person checks in the wallet. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const SERVER_ERRORS: Record<string, string> = {
  WALLET_TAKEN: "taken",
  WALLET_UNDER_REVIEW: "review",
  WALLET_PAYOUTS_PENDING: "blocked",
};

/**
 * The account wallet in "Sign-in and security" (D518). The existing
 * WalletConnect or browser wallet connects; a SIWE signature checked on the
 * server links the address. Change and disconnect show what they touch
 * first; owed UGC rewards hold the address until they are paid.
 */
export function AccountWallet({
  address,
  projectId,
  blocked,
  openPayments,
  unpaidOrders,
  owedRewards,
}: {
  address: string | null;
  projectId: string;
  blocked: boolean;
  openPayments: number;
  unpaidOrders: number;
  owedRewards: number;
}) {
  const t = useTranslations("account.wallet");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"change" | "disconnect" | null>(
    null,
  );
  const [message, setMessage] = useState("");

  async function link(route: WalletRoute) {
    setBusy(true);
    setMessage("");
    try {
      const provider = await connectWallet(projectId, route);
      const accounts = (await provider.request({
        method: "eth_accounts",
      })) as string[];
      const chainId = Number(
        (await provider.request({ method: "eth_chainId" })) as string,
      );
      const wallet = accounts[0];
      if (!wallet) throw new Error("wallet");
      const nonce = await fetch("/api/me/wallet/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: wallet, chainId }),
      });
      if (!nonce.ok) return setMessage(await reason(nonce));
      const { message: text } = (await nonce.json()) as { message: string };
      const signature = (await provider.request({
        method: "personal_sign",
        params: [text, wallet],
      })) as string;
      const verified = await fetch("/api/me/wallet/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature }),
      });
      if (!verified.ok) return setMessage(await reason(verified));
      setConfirming(null);
      setMessage(t("linked"));
      router.refresh();
    } catch (caught) {
      setMessage(t(`error.${classifyPayError(caught)}`));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/me/wallet", { method: "DELETE" }).catch(
      () => null,
    );
    setBusy(false);
    if (!response?.ok) {
      setMessage(response ? await reason(response) : t("error.failed"));
      return;
    }
    setConfirming(null);
    setMessage(t("unlinked"));
    router.refresh();
  }

  async function reason(response: Response): Promise<string> {
    if (response.status === 400) return t("error.network");
    if (response.status === 429) return t("error.rate");
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    const key = SERVER_ERRORS[body?.error?.code ?? ""];
    return t(`error.${key ?? "failed"}`);
  }

  const connectButtons = (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="secondary"
        loading={busy}
        onClick={() => void link("browser")}
      >
        {address ? t("changeBrowser") : t("connect")}
      </Button>
      {projectId ? (
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => void link("qr")}
        >
          {t("qr")}
        </Button>
      ) : null}
    </div>
  );

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-line p-4 md:p-6"
      aria-busy={busy}
    >
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">{t("title")}</h3>
        <p className="t-body-s text-fg-muted">{t("text")}</p>
      </div>
      {address ? (
        <p className="t-body-s">
          {t("connected")}{" "}
          <span className="font-mono" title={address}>
            {shortAddress(address)}
          </span>
          <span className="sr-only">{address}</span>
        </p>
      ) : (
        <p className="t-body-s text-fg-muted">{t("none")}</p>
      )}

      {address && blocked ? (
        <p className="t-body-s">{t("blocked", { count: owedRewards })}</p>
      ) : null}

      {!address ? connectButtons : null}

      {address && !blocked && confirming === null ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setConfirming("change")}
          >
            {t("change")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirming("disconnect")}
          >
            {t("disconnect")}
          </Button>
        </div>
      ) : null}

      {address && !blocked && confirming !== null ? (
        <div className="flex flex-col gap-3 rounded-md border border-line p-4">
          <p className="t-body-s font-medium">
            {t(confirming === "change" ? "changeTitle" : "disconnectTitle")}
          </p>
          <ul className="t-body-s flex list-disc flex-col gap-1 pl-5 text-fg-muted">
            <li>{t("keepsHistory")}</li>
            {openPayments > 0 ? (
              <li>{t("openPayments", { count: openPayments })}</li>
            ) : null}
            {unpaidOrders > 0 ? (
              <li>
                {t(
                  confirming === "change"
                    ? "unpaidOrdersChange"
                    : "unpaidOrdersDisconnect",
                  { count: unpaidOrders },
                )}
              </li>
            ) : null}
          </ul>
          {confirming === "change" ? (
            connectButtons
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="danger"
                loading={busy}
                onClick={() => void disconnect()}
              >
                {t("disconnectConfirm")}
              </Button>
            </div>
          )}
          <Button
            type="button"
            variant="ghost"
            className="self-start"
            disabled={busy}
            onClick={() => setConfirming(null)}
          >
            {t("cancel")}
          </Button>
        </div>
      ) : null}

      {message ? (
        <p role="status" className="t-body-s">
          {message}
        </p>
      ) : null}
    </div>
  );
}
