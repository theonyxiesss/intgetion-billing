import type { BillingPorts } from "../ports";

export type PlatformConfig = {
  platformUrl: string;
  callbackToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** Ports answered by the platform over HTTP, so billing never reads platform code. */
export function httpPlatformPorts(config: PlatformConfig): BillingPorts {
  const base = config.platformUrl.replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 5000;

  async function call(path: string, init: RequestInit): Promise<Response> {
    const response = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.callbackToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`platform ${path} answered ${response.status}`);
    }
    return response;
  }

  return {
    async notifyPlatformOwners(subject, text) {
      await call("/api/internal/billing/notify-owners", {
        method: "POST",
        body: JSON.stringify({ subject, text }),
      });
    },
    async findMemberRole(companyId, userId) {
      const query = new URLSearchParams({ companyId, userId });
      const response = await call(
        `/api/internal/billing/member-role?${query}`,
        { method: "GET" },
      );
      const body = (await response.json()) as { role?: string | null };
      return body.role ?? null;
    },
  };
}
