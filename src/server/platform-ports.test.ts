import { describe, expect, it, vi } from "vitest";
import { httpPlatformPorts } from "./platform-ports";

describe("platform ports over HTTP", () => {
  it("asks the platform for a member role with the callback token", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ role: "owner" }));
    const ports = httpPlatformPorts({
      platformUrl: "https://platform.test/",
      callbackToken: "cb",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(ports.findMemberRole("c1", "u1")).resolves.toBe("owner");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://platform.test/api/internal/billing/member-role?companyId=c1&userId=u1",
    );
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer cb");
  });

  it("fails loudly when the platform refuses", async () => {
    const ports = httpPlatformPorts({
      platformUrl: "https://platform.test",
      callbackToken: "cb",
      fetchImpl: (async () => new Response(null, { status: 503 })) as typeof fetch,
    });
    await expect(ports.notifyPlatformOwners("s", "t")).rejects.toThrow("503");
  });
});
