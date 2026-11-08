/**
 * Price list shown on /pricing (docs/PRICING.md, section 1A).
 * The charge is the same dollars in `plans.price_minor` (D358).
 */

export type PricingAudience = "companies" | "candidates";

export type PricingTier = {
  code: string;
  /** Whole US dollars; null for free. */
  price: number | null;
  /** How the price is counted: once per job or per month. */
  per: "job" | "month" | null;
  /** Yearly price in whole dollars, for subscriptions. */
  yearly?: number;
  recommended?: boolean;
  /** Message keys under pricing.tiers.<code>.points */
  points: readonly string[];
};

export const PRICING: Record<PricingAudience, readonly PricingTier[]> = {
  companies: [
    {
      code: "start",
      price: null,
      per: null,
      points: ["jobs", "catalog", "applications", "digest", "stats"],
    },
    {
      code: "hire",
      price: 79,
      per: "job",
      recommended: true,
      points: ["guarantee", "instant", "promoted", "forecast", "firstFree"],
    },
    {
      code: "team",
      price: 80,
      per: "month",
      yearly: 800,
      points: ["jobs", "promoted", "team", "api", "channel"],
    },
  ],
  candidates: [
    {
      code: "free",
      price: null,
      per: null,
      points: ["search", "apply", "match", "alerts", "agent"],
    },
    {
      code: "plus",
      price: 5,
      per: "month",
      yearly: 39,
      recommended: true,
      points: ["instant", "agent", "letters", "views", "hidden"],
    },
    {
      code: "pro",
      price: 15,
      per: "month",
      yearly: 119,
      points: ["agent", "interview", "review", "salary", "views"],
    },
  ],
};

/**
 * One set of plans per account (D587): the same person searches, hires,
 * sells services and runs UGC. Keys under pricing.account.tiers.<code>.
 * Checkout still sells the plans in `SALE_PLANS`.
 */
export const ACCOUNT_PLANS: readonly PricingTier[] = [
  {
    code: "free",
    price: null,
    per: null,
    points: ["search", "freelance", "jobs", "ugc", "agent"],
  },
  {
    code: "plus",
    price: 5,
    per: "month",
    yearly: 39,
    recommended: true,
    points: ["agent", "instant", "letters", "views", "commission"],
  },
  {
    code: "pro",
    price: 15,
    per: "month",
    yearly: 119,
    points: ["agent", "interview", "salary", "review", "commission"],
  },
  {
    code: "team",
    price: 80,
    per: "month",
    yearly: 800,
    points: ["seats", "jobs", "api", "channel", "commission"],
  },
];

