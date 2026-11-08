import { z, ZodError } from "zod";
import {
  HttpError,
  httpErrorResponse,
  notFound,
  reportError,
  validationError,
} from "@intgetion/kit";
import * as billing from "../modules/billing/service";
import { sendHireMail } from "../modules/billing/service/hire-mail";
import {
  isUuid,
  optionalCaller,
  requireCaller,
  requireServiceToken,
} from "./auth";

export type AppConfig = { serviceToken: string };

const orderBody = z
  .object({
    plan: z.enum(["hire", "team", "plus", "pro"]).default("hire"),
    token: z.enum(["USDC", "USDT"]),
    jobId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.plan === "hire" && !value.jobId) {
      ctx.addIssue({ code: "custom", path: ["jobId"], message: "job" });
    }
    if (value.plan === "team" && !value.companyId) {
      ctx.addIssue({ code: "custom", path: ["companyId"], message: "company" });
    }
  });

const confirmBody = z.object({
  orderId: z.string().uuid(),
  txHash: z.string().min(1),
});

const nonceBody = z.union([
  z.object({
    network: z.enum(["tron", "solana"]),
    address: z.string().min(1).max(64),
  }),
  z.object({ address: z.string().min(1), chainId: z.number().int() }),
]);

const verifyBody = z.object({ signature: z.string().min(1) });

const interestBody = z.object({
  email: z.string().email().optional(),
  token: z.enum(["USDC", "USDT"]).optional(),
  chain: z.string().max(32).optional(),
});

const MAX_BODY = 16 * 1024;

async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const text = await request.text();
  if (text.length > MAX_BODY) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Body too large");
  }
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw validationError({ body: "invalid json" });
  }
  return schema.parse(json);
}

function uuidParam(value: string | undefined): string {
  if (!value || !isUuid(value)) throw notFound();
  return value;
}

type Route = {
  method: string;
  pattern: RegExp;
  run: (request: Request, params: string[], url: URL) => Promise<unknown>;
};

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/v1\/features$/,
    run: async () => ({
      checkoutOn: billing.cryptoCheckoutOn(),
      hire: billing.hireFeatures(),
    }),
  },
  {
    method: "GET",
    pattern: /^\/v1\/me$/,
    run: async (request) => billing.billingMe(requireCaller(request).userId),
  },
  {
    method: "GET",
    pattern: /^\/v1\/payable$/,
    run: async (request) => {
      const { userId } = requireCaller(request);
      const [jobs, companies] = await Promise.all([
        billing.payableJobs(userId),
        billing.payableCompanies(userId),
      ]);
      return { jobs, companies };
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/companies\/([^/]+)$/,
    run: async (request, [id]) =>
      billing.billingForCompany(requireCaller(request).userId, uuidParam(id)),
  },
  {
    method: "GET",
    pattern: /^\/v1\/companies\/([^/]+)\/active-team$/,
    run: async (_request, [id]) => ({
      active: await billing.companyHasActiveTeam(uuidParam(id)),
    }),
  },
  {
    method: "GET",
    pattern: /^\/v1\/jobs\/([^/]+)\/hire$/,
    run: async (_request, [id]) => ({
      paid: await billing.hireForJob(uuidParam(id)),
    }),
  },
  {
    method: "GET",
    pattern: /^\/v1\/promoted-jobs$/,
    run: async () => ({ jobIds: await billing.promotedHireJobIds() }),
  },
  {
    method: "POST",
    pattern: /^\/v1\/interest$/,
    run: async (request) => {
      const caller = optionalCaller(request);
      const input = await readBody(request, interestBody);
      await billing.recordBillingInterest({
        userId: caller?.userId ?? null,
        email: input.email ?? null,
        token: input.token ?? null,
        chain: input.chain ?? null,
      });
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/orders$/,
    run: async (request) => {
      const { userId } = requireCaller(request);
      return billing.createCryptoOrder(userId, await readBody(request, orderBody));
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/orders\/confirm$/,
    run: async (request) => {
      const caller = requireCaller(request);
      const input = await readBody(request, confirmBody);
      const result = await billing.confirmHireOrder(
        caller.userId,
        input.orderId,
        input.txHash,
      );
      if (result.granted && result.plan === "hire" && result.jobId) {
        await sendHireMail({
          to: caller.email,
          locale: caller.locale,
          jobId: result.jobId,
        });
      }
      return result;
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/orders\/([^/]+)$/,
    run: async (request, [id]) =>
      billing.refreshHireOrder(requireCaller(request).userId, uuidParam(id)),
  },
  {
    method: "POST",
    pattern: /^\/v1\/wallet\/nonce$/,
    run: async (request) => {
      const { userId } = requireCaller(request);
      const input = await readBody(request, nonceBody);
      if ("network" in input) {
        return billing.issueNonEvmNonce(userId, input.network, input.address);
      }
      return billing.issueWalletNonce(userId, input.address, input.chainId);
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/wallet\/verify$/,
    run: async (request) => {
      const { userId } = requireCaller(request);
      const input = await readBody(request, verifyBody);
      await billing.verifyWalletSignature(userId, input.signature);
      return { ok: true };
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/wallet$/,
    run: async (request) => ({
      wallet: await billing.verifiedPayerWallet(requireCaller(request).userId),
    }),
  },
  {
    method: "GET",
    pattern: /^\/v1\/sanctions\/check$/,
    run: async (_request, _params, url) => {
      const address = url.searchParams.get("address");
      if (!address) throw validationError({ query: "address" });
      return { sanctioned: await billing.isSanctionedAddress(address) };
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/jobs\/recheck-orders$/,
    run: async () => ({ ok: true, checked: await billing.recheckSubmittedOrders() }),
  },
  {
    method: "POST",
    pattern: /^\/v1\/jobs\/refresh-sanctions$/,
    run: async () => ({ ok: true, ...(await billing.refreshSanctionsList()) }),
  },
];

export function toResponse(error: unknown): Response {
  if (error instanceof HttpError) return httpErrorResponse(error);
  if (error instanceof ZodError) {
    return httpErrorResponse(validationError(error.issues));
  }
  reportError(error, "billing-service");
  return Response.json(
    { error: { code: "INTERNAL", message: "Internal error" } },
    { status: 500 },
  );
}

export function createApp(config: AppConfig) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true });
      }
      requireServiceToken(request, config.serviceToken);
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        return Response.json(await route.run(request, match.slice(1), url));
      }
      throw notFound();
    } catch (error) {
      return toResponse(error);
    }
  };
}
