import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  cryptoCheckoutOn: vi.fn(() => true),
  hireFeatures: vi.fn(() => ({ promotedDays: 7 })),
  billingMe: vi.fn(async () => ({ plan: "start" })),
  createCryptoOrder: vi.fn(async () => ({ id: "order" })),
  confirmHireOrder: vi.fn(async () => ({
    granted: true,
    plan: "hire",
    jobId: "11111111-1111-4111-8111-111111111111",
  })),
  isSanctionedAddress: vi.fn(async () => false),
}));
const sendHireMail = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../modules/billing/service", () => service);
vi.mock("../modules/billing/service/hire-mail", () => ({ sendHireMail }));

const { createApp } = await import("./app");

const TOKEN = "test-service-token";
const USER = "22222222-2222-4222-8222-222222222222";
const handle = createApp({ serviceToken: TOKEN });

function call(path: string, init: RequestInit & { user?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  if (init.user) headers.set("x-user-id", init.user);
  return handle(new Request(`http://billing${path}`, { ...init, headers }));
}

beforeEach(() => vi.clearAllMocks());

describe("billing service HTTP", () => {
  it("answers health without a token", async () => {
    const response = await handle(new Request("http://billing/health"));
    expect(response.status).toBe(200);
  });

  it("refuses a wrong service token", async () => {
    const response = await handle(
      new Request("http://billing/v1/features", {
        headers: { authorization: "Bearer nope" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("needs a user for account routes", async () => {
    expect((await call("/v1/me")).status).toBe(401);
    expect((await call("/v1/me", { user: "not-a-uuid" })).status).toBe(400);
    const ok = await call("/v1/me", { user: USER });
    expect(ok.status).toBe(200);
    expect(service.billingMe).toHaveBeenCalledWith(USER);
  });

  it("validates an order body", async () => {
    const bad = await call("/v1/orders", {
      method: "POST",
      user: USER,
      body: JSON.stringify({ plan: "hire", token: "USDC" }),
    });
    expect(bad.status).toBe(400);
    expect(service.createCryptoOrder).not.toHaveBeenCalled();
  });

  it("mails the buyer after a granted hire payment", async () => {
    const response = await call("/v1/orders/confirm", {
      method: "POST",
      user: USER,
      headers: { "x-user-email": "buyer@example.test", "x-user-locale": "ru" },
      body: JSON.stringify({
        orderId: "33333333-3333-4333-8333-333333333333",
        txHash: "0xabc",
      }),
    });
    expect(response.status).toBe(200);
    expect(sendHireMail).toHaveBeenCalledWith({
      to: "buyer@example.test",
      locale: "ru",
      jobId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("returns 404 for unknown routes", async () => {
    expect((await call("/v1/nothing")).status).toBe(404);
  });
});
