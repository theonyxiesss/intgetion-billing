"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui";

export function InterestForm() {
  const t = useTranslations("billing");
  const [done, setDone] = useState(false);
  const [email, setEmail] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/billing/interest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (response.ok) setDone(true);
  }

  if (done) return <p>{t("interestDone")}</p>;

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-4">
      <h2 className="t-h3">{t("interestTitle")}</h2>
      <p className="text-fg-muted">{t("interestBody")}</p>
      <label className="flex flex-col gap-2 text-sm">
        {t("interestEmail")}
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="rounded-md border border-line bg-bg px-3 py-2"
        />
      </label>
      <Button type="submit">{t("interestSend")}</Button>
    </form>
  );
}
