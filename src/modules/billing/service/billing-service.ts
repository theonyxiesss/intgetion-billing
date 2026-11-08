import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, logger, forbidden, HttpError, notFound, validationError } from "@intgetion/kit";
import { billingPorts } from "../../../ports";
import { chainById, tokenContract } from "../../../lib/billing/chains";
import { readChain } from "../../../lib/billing/rpc";
import {
  nonEvmByChainId,
  nonEvmNetwork,
  nonEvmRecipient,
  nonEvmToken,
  readyNonEvmNetworks,
  validNonEvmAddress,
  validTxId,
  type NonEvmNetworkId,
} from "../../../lib/billing/non-evm/networks";
import { readSolana, readTron } from "../../../lib/billing/non-evm/rpc";
import {
  nonEvmMessage,
  verifyNonEvmSignature,
} from "../../../lib/billing/non-evm/signature";
import {
  verifySolanaTransfer,
  verifyTronTransfer,
} from "../../../lib/billing/non-evm/verify-receipt";
import {
  recoverSiweAddress,
  siweMessage,
  validAddress,
} from "../../../lib/billing/siwe";
import {
  clientStatus,
  HIRE_DAYS,
  HIRE_PLAN,
  formatTokenAmount,
  hireGrants,
  isHirePromoted,
  SALE_PLANS,
  settlement,
  type ClientBillingStatus,
  type OrderStatus,
  type SaleSlug,
} from "../../../lib/billing/status";
import {
  normalizeAddress,
  OFAC_SDN_URL,
  parseSdnCryptoAddresses,
} from "../../../lib/billing/sanctions";
import { tokenUnits, verifyTransfer } from "../../../lib/billing/verify-transfer";

type OrderRow = {
  id: string;
  purchase_id: string;
  user_id: string;
  job_id: string | null;
  company_id: string | null;
  plan_code: string;
  chain: string;
  token: string;
  token_contract: string;
  recipient: string;
  payer_address: string;
  amount_minor: string;
  token_amount: string;
  status: OrderStatus;
  reason: string | null;
  tx_hash: string | null;
  expires_at: string;
  created_at: string;
};

export type GrantedPlan = "start" | "hire" | "team" | "plus" | "pro";

export type OrderView = {
  id: string;
  jobId: string;
  status: ClientBillingStatus;
  plan: GrantedPlan;
  chain: string;
  chainId: number;
  token: string;
  tokenContract: string;
  recipient: string;
  tokenAmount: string;
  expiresAt: string;
};

export type BillingMe = {
  plan: "start" | "hire" | "team";
  candidatePlan: "free" | "plus" | "pro";
  crypto: boolean;
  hires: { jobId: string; validUntil: string }[];
  teamUntil: string | null;
  candidateUntil: string | null;
};

export type CompanyBilling = Pick<BillingMe, "plan" | "hires" | "teamUntil">;

function cryptoReady(chain: string, token: string): boolean {
  return (
    process.env.BILLING_ENABLED === "true" &&
    process.env.BILLING_CRYPTO_PROVIDER === "walletconnect" &&
    validAddress(process.env.COMPANY_WALLET_ADDRESS ?? "") !== null &&
    tokenContract(chain, token) !== null
  );
}

function view(row: OrderRow, now = new Date()): OrderView {
  const status = clientStatus({
    status: row.status,
    reason: row.reason,
    expiresAt: new Date(row.expires_at),
    now,
  });
  const chain = chainById(row.chain) ?? nonEvmNetwork(row.chain);
  return {
    id: row.id,
    jobId: row.job_id ?? "",
    status,
    plan: status === "paid" ? grantedPlan(row.plan_code) : "start",
    chain: row.chain,
    chainId: chain?.chainId ?? 0,
    token: row.token,
    tokenContract: row.token_contract,
    recipient: row.recipient,
    tokenAmount: formatTokenAmount(row.token_amount),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function grantedPlan(code: string): GrantedPlan {
  if (code === SALE_PLANS.team.code) return "team";
  if (code === SALE_PLANS.plus.code) return "plus";
  if (code === SALE_PLANS.pro.code) return "pro";
  if (code === SALE_PLANS.hire.code) return "hire";
  return "start";
}

async function loadOrder(orderId: string, userId: string): Promise<OrderRow> {
  const rows = await getDb().execute<OrderRow>(sql`
    select o.id, o.purchase_id, o.user_id, p.job_id, p.company_id, p.plan_code, o.chain, o.token,
           o.token_contract, o.recipient, o.payer_address, o.amount_minor::text,
           o.token_amount, o.status, o.reason, o.tx_hash,
           o.expires_at::text, o.created_at::text
    from crypto_orders o
    join purchases p on p.id = o.purchase_id
    where o.id = ${orderId} and o.user_id = ${userId}
  `);
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** Published jobs this owner can pay Hire for. */
export async function payableJobs(
  userId: string,
): Promise<{ id: string; title: string }[]> {
  return getDb().execute<{ id: string; title: string }>(sql`
    select j.id, j.title
    from jobs j
    join company_members m on m.company_id = j.company_id
    where m.user_id = ${userId}
      and m.role = 'owner'
      and j.source = 'internal'
      and j.status = 'published'
    order by j.created_at desc
    limit 20
  `);
}

/** A paid Team plan that is still inside its 30 days (D367). */
export async function companyHasActiveTeam(
  companyId: string,
): Promise<boolean> {
  const rows = await getDb().execute<{ ok: number }>(sql`
    select 1 as ok
    from public.purchases
    where company_id = ${companyId}
      and plan_code = ${SALE_PLANS.team.code}
      and status = 'paid'
      and valid_until > now()
    limit 1
  `);
  return Boolean(rows[0]);
}

/** Companies this owner can pay Team for. */
export async function payableCompanies(
  userId: string,
): Promise<{ id: string; name: string }[]> {
  return getDb().execute<{ id: string; name: string }>(sql`
    select c.id, c.name
    from companies c
    join company_members m on m.company_id = c.id
    where m.user_id = ${userId}
      and m.role = 'owner'
    order by c.created_at asc
    limit 20
  `);
}

function latestUntil(
  rows: { plan_code: string; valid_until: string }[],
  code: string,
): string | null {
  const times = rows
    .filter((row) => row.plan_code === code)
    .map((row) => new Date(row.valid_until).getTime());
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

type PurchaseRow = {
  plan_code: string;
  job_id: string | null;
  valid_until: string;
};

export async function billingMe(userId: string): Promise<BillingMe> {
  const rows: PurchaseRow[] = await getDb().execute<PurchaseRow>(sql`
    select p.plan_code, p.job_id, p.valid_until::text
    from purchases p
    where p.status = 'paid'
      and p.valid_until > now()
      and (
        p.user_id = ${userId}
        or exists (
          select 1 from company_members m
          where m.company_id = p.company_id and m.user_id = ${userId}
        )
      )
  `);
  const hires = rows.filter((row) => row.plan_code === HIRE_PLAN && row.job_id);
  const teamUntil = latestUntil(rows, SALE_PLANS.team.code);
  const proUntil = latestUntil(rows, SALE_PLANS.pro.code);
  const plusUntil = latestUntil(rows, SALE_PLANS.plus.code);
  return {
    plan: teamUntil ? "team" : hires.length > 0 ? "hire" : "start",
    candidatePlan: proUntil ? "pro" : plusUntil ? "plus" : "free",
    crypto: cryptoReady("base", "USDC") || cryptoReady("base", "USDT"),
    hires: hires.map((row) => ({
      jobId: row.job_id as string,
      validUntil: new Date(row.valid_until).toISOString(),
    })),
    teamUntil,
    candidateUntil: proUntil ?? plusUntil,
  };
}

export async function billingForCompany(
  userId: string,
  companyId: string,
): Promise<CompanyBilling> {
  if (!(await billingPorts().findMemberRole(companyId, userId))) throw notFound();
  const rows: PurchaseRow[] = await getDb().execute<PurchaseRow>(sql`
    select p.plan_code, p.job_id, p.valid_until::text
    from purchases p
    where p.company_id = ${companyId}
      and p.status = 'paid'
      and p.valid_until > now()
  `);
  const hires = rows.filter((row) => row.plan_code === HIRE_PLAN && row.job_id);
  const teamUntil = latestUntil(rows, SALE_PLANS.team.code);
  return {
    plan: teamUntil ? "team" : hires.length > 0 ? "hire" : "start",
    hires: hires.map((row) => ({
      jobId: row.job_id as string,
      validUntil: new Date(row.valid_until).toISOString(),
    })),
    teamUntil,
  };
}

/** Published Hire jobs still inside the 7-day promoted window (D366). */
export async function promotedHireJobIds(now = new Date()): Promise<string[]> {
  const since = new Date(
    now.getTime() - hireGrants().promotedDays * 24 * 60 * 60 * 1000,
  );
  const rows = await getDb().execute<{
    job_id: string;
    created_at: string;
  }>(sql`
    select p.job_id::text, p.created_at::text
    from public.purchases p
    join public.jobs j on j.id = p.job_id
    join public.companies c on c.id = j.company_id
    where p.plan_code = ${HIRE_PLAN}
      and p.status = 'paid'
      and p.job_id is not null
      and p.valid_until > ${now.toISOString()}
      and p.created_at > ${since.toISOString()}
      and j.status = 'published'
      and j.source = 'internal'
      and c.status not in ('suspended', 'rejected')
    order by p.created_at desc
    limit 12
  `);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rows) {
    if (!row.job_id || seen.has(row.job_id)) continue;
    if (!isHirePromoted(new Date(row.created_at), now)) continue;
    seen.add(row.job_id);
    ids.push(row.job_id);
  }
  return ids;
}

export async function hireForJob(jobId: string): Promise<boolean> {
  const rows = await getDb().execute<{ id: string }>(sql`
    select id from purchases
    where job_id = ${jobId}
      and plan_code = ${HIRE_PLAN}
      and status = 'paid'
      and valid_until > now()
    limit 1
  `);
  return Boolean(rows[0]);
}

export function hireFeatures() {
  return hireGrants();
}

export async function issueWalletNonce(
  userId: string,
  address: string,
  chainId: number,
): Promise<{ message: string }> {
  const checksum = validAddress(address);
  const chain = chainById(chainByChain(chainId));
  if (!checksum || !chain) throw validationError("Unknown wallet or network");
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiration = new Date(issuedAt.getTime() + 10 * 60 * 1000);
  const message = siweMessage({
    address: checksum,
    chainId: chain.chainId,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expirationTime: expiration.toISOString(),
  });
  await getDb().execute(sql`
    insert into billing_wallet_sessions (user_id, address, chain_id, nonce, message, expires_at)
    values (${userId}, ${checksum.toLowerCase()}, ${chain.chainId}, ${nonce}, ${message}, ${expiration.toISOString()})
    on conflict (user_id) do update
      set address = excluded.address,
          chain_id = excluded.chain_id,
          nonce = excluded.nonce,
          message = excluded.message,
          expires_at = excluded.expires_at
  `);
  return { message };
}

/** Tron / Solana: the buyer proves the sender address by signing (D384). */
export async function issueNonEvmNonce(
  userId: string,
  network: string,
  address: string,
): Promise<{ message: string }> {
  const found = nonEvmNetwork(network);
  const trimmed = address.trim();
  if (!found || !readyNonEvmNetworks().includes(found.id)) {
    throw new HttpError(409, "CHAIN_UNSUPPORTED", "Use a supported network");
  }
  if (!validNonEvmAddress(found.id, trimmed)) {
    throw validationError("Unknown wallet or network");
  }
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiration = new Date(issuedAt.getTime() + 10 * 60 * 1000);
  const message = nonEvmMessage({
    network: found.id,
    address: trimmed,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expirationTime: expiration.toISOString(),
  });
  await getDb().execute(sql`
    insert into billing_wallet_sessions (user_id, address, chain_id, nonce, message, expires_at)
    values (${userId}, ${trimmed}, ${found.chainId}, ${nonce}, ${message}, ${expiration.toISOString()})
    on conflict (user_id) do update
      set address = excluded.address,
          chain_id = excluded.chain_id,
          nonce = excluded.nonce,
          message = excluded.message,
          expires_at = excluded.expires_at
  `);
  return { message };
}

function chainByChain(chainId: number): string {
  const nonEvm = nonEvmByChainId(chainId);
  if (nonEvm) return nonEvm.id;
  if (chainId === 1) return "ethereum";
  if (chainId === 137) return "polygon";
  if (chainId === 42161) return "arbitrum";
  if (chainId === 8453) return "base";
  return "";
}

export async function verifyWalletSignature(
  userId: string,
  signature: string,
): Promise<void> {
  if (!signature) throw validationError("Missing signature");
  const rows = await getDb().execute<{
    chain_id: number;
    address: string;
    message: string | null;
    expires_at: string;
    nonce: string;
  }>(sql`
    select chain_id, address, message, expires_at::text, nonce
    from billing_wallet_sessions
    where user_id = ${userId}
  `);
  const session = rows[0];
  if (!session?.message || new Date(session.expires_at) <= new Date()) {
    throw forbidden();
  }
  const nonEvm = nonEvmByChainId(session.chain_id);
  if (nonEvm) {
    const proven = await verifyNonEvmSignature(
      nonEvm.id,
      session.message,
      signature,
      session.address,
    );
    if (!proven) throw forbidden();
  } else {
    if (!signature.startsWith("0x")) throw validationError("Missing signature");
    const recovered = await recoverSiweAddress(
      session.message,
      signature as `0x${string}`,
    );
    if (!recovered || recovered !== session.address.toLowerCase())
      throw forbidden();
  }
  const until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await getDb().execute(sql`
    update billing_wallet_sessions
    set nonce = 'verified', expires_at = ${until}
    where user_id = ${userId} and nonce = ${session.nonce}
  `);
}

/**
 * The EVM wallet this user proved with SIWE in the last 30 minutes, for a
 * payment that is not a plan (freelance orders, D463). Null otherwise.
 */
export async function verifiedPayerWallet(
  userId: string,
  now = new Date(),
): Promise<{ address: string; chainId: number } | null> {
  const rows = await getDb().execute<{
    address: string;
    chain_id: number;
    nonce: string;
    expires_at: string;
  }>(sql`
    select address, chain_id, nonce, expires_at::text
    from billing_wallet_sessions
    where user_id = ${userId}
  `);
  const row = rows[0];
  if (!row || row.nonce !== "verified" || new Date(row.expires_at) <= now) {
    return null;
  }
  if (nonEvmByChainId(row.chain_id)) return null;
  return { address: row.address.toLowerCase(), chainId: row.chain_id };
}

/** Crypto checkout is on (the flags of D356); the recipient is not checked here. */
export function cryptoCheckoutOn(): boolean {
  return (
    process.env.BILLING_ENABLED === "true" &&
    process.env.BILLING_CRYPTO_PROVIDER === "walletconnect"
  );
}

const ORDER_COLUMNS = sql`
  o.id, o.purchase_id, o.user_id, p.job_id, p.company_id, p.plan_code, o.chain, o.token,
  o.token_contract, o.recipient, o.payer_address, o.amount_minor::text,
  o.token_amount, o.status, o.reason, o.tx_hash,
  o.expires_at::text, o.created_at::text
`;

export async function createHireOrder(
  userId: string,
  jobId: string,
  token: "USDC" | "USDT",
): Promise<OrderView> {
  return createCryptoOrder(userId, { plan: "hire", token, jobId });
}

export async function createCryptoOrder(
  userId: string,
  input: {
    plan: SaleSlug;
    token: "USDC" | "USDT";
    jobId?: string;
    companyId?: string;
  },
): Promise<OrderView> {
  const spec = SALE_PLANS[input.plan];
  const priced = await getDb().execute<{ price_minor: string }>(sql`
    select price_minor::text as price_minor
    from plans
    where code = ${spec.code} and active = true
  `);
  const priceMinor = priced[0] ? BigInt(priced[0].price_minor) : null;
  if (priceMinor === null || priceMinor !== spec.priceMinor) {
    throw new HttpError(409, "BILLING_UNAVAILABLE", "This plan is not on sale");
  }

  let companyId: string | null = null;
  let jobId: string | null = null;
  let buyerId: string | null = null;

  if (input.plan === "hire") {
    if (!input.jobId) throw validationError("Choose a job");
    const job = await getDb().execute<{
      company_id: string;
      source: string;
      status: string;
    }>(sql`
      select company_id, source, status from jobs where id = ${input.jobId}
    `);
    const row = job[0];
    if (!row || row.source !== "internal") throw notFound();
    if (row.status !== "published") {
      throw new HttpError(409, "JOB_NOT_PUBLISHED", "Publish the job first");
    }
    const role = await billingPorts().findMemberRole(row.company_id, userId);
    if (role !== "owner") throw forbidden();
    companyId = row.company_id;
    jobId = input.jobId;

    const existing = await getDb().execute<{ id: string }>(sql`
      select o.id
      from crypto_orders o
      join purchases p on p.id = o.purchase_id
      where p.job_id = ${jobId}
        and p.plan_code = ${spec.code}
        and p.status = 'paid'
        and p.valid_until > now()
      limit 1
    `);
    if (existing[0]) {
      const paid = await getDb().execute<OrderRow>(sql`
        select ${ORDER_COLUMNS}
        from crypto_orders o
        join purchases p on p.id = o.purchase_id
        where o.id = ${existing[0].id}
      `);
      if (paid[0]) return view(paid[0]);
    }
  } else if (input.plan === "team") {
    if (!input.companyId) throw validationError("Choose a company");
    const role = await billingPorts().findMemberRole(input.companyId, userId);
    if (role !== "owner") throw forbidden();
    companyId = input.companyId;
  } else {
    buyerId = userId;
  }

  const session = await getDb().execute<{
    address: string;
    chain_id: number;
    nonce: string;
    expires_at: string;
  }>(sql`
    select address, chain_id, nonce, expires_at::text
    from billing_wallet_sessions
    where user_id = ${userId}
  `);
  const wallet = session[0];
  if (
    !wallet ||
    wallet.nonce !== "verified" ||
    new Date(wallet.expires_at) <= new Date()
  ) {
    throw new HttpError(
      409,
      "WALLET_REQUIRED",
      "Sign in with the wallet first",
    );
  }
  const chainName = chainByChain(wallet.chain_id);
  const nonEvm = nonEvmNetwork(chainName);
  const chain = chainById(chainName) ?? nonEvm;
  const contract = nonEvm
    ? nonEvmToken(nonEvm.id, input.token)
    : tokenContract(chainName, input.token);
  const recipient = nonEvm
    ? nonEvmRecipient(nonEvm.id)
    : (validAddress(process.env.COMPANY_WALLET_ADDRESS ?? "")?.toLowerCase() ??
      null);
  const ready = nonEvm
    ? readyNonEvmNetworks().includes(nonEvm.id)
    : cryptoReady(chainName, input.token);
  if (!chain) {
    throw new HttpError(409, "CHAIN_UNSUPPORTED", "Use a supported network");
  }
  if (!contract) {
    throw new HttpError(
      409,
      "TOKEN_UNSUPPORTED",
      "This token is not on this network",
    );
  }
  if (!recipient || !ready) {
    throw new HttpError(
      409,
      "BILLING_UNAVAILABLE",
      "Crypto payments are not on",
    );
  }

  const units = tokenUnits(priceMinor).toString();
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const created = await getDb().transaction(async (tx) => {
    const purchase = await tx.execute<{ id: string }>(sql`
      insert into purchases (company_id, job_id, user_id, plan_code, status)
      values (${companyId}, ${jobId}, ${buyerId}, ${spec.code}, 'pending')
      returning id
    `);
    const purchaseId = purchase[0]?.id;
    if (!purchaseId)
      throw new HttpError(500, "BILLING_FAILED", "Could not open the order");
    const order = await tx.execute<{ id: string }>(sql`
      insert into crypto_orders (
        purchase_id, user_id, chain, token, token_contract, recipient, payer_address,
        amount_minor, token_amount, status, expires_at
      )
      values (
        ${purchaseId}, ${userId}, ${chain.id}, ${input.token}, ${contract},
        ${recipient}, ${nonEvm ? wallet.address : wallet.address.toLowerCase()},
        ${priceMinor.toString()}, ${units}, 'open', ${expires}
      )
      returning id
    `);
    return order[0]?.id;
  });
  if (!created)
    throw new HttpError(500, "BILLING_FAILED", "Could not open the order");
  return view(await loadOrder(created, userId));
}

export async function confirmHireOrder(
  userId: string,
  orderId: string,
  txHash: string,
): Promise<OrderView & { granted: boolean }> {
  const order = await loadOrder(orderId, userId);
  const nonEvm = nonEvmNetwork(order.chain);
  if (nonEvm) {
    if (!validTxId(nonEvm.id, txHash))
      throw validationError("Missing transaction");
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw validationError("Missing transaction");
  }
  if (order.status === "confirmed") return { ...view(order), granted: false };
  const verified = nonEvm
    ? await verifyNonEvmOrder(order, nonEvm.id, txHash)
    : await verifyEvmOrder(order, txHash);
  const next = settlement(verified);
  if (!next.grant) {
    // D589: a failed check proved the hash is not this order's payment (other
    // payer, recipient or no transfer), so the order does not keep it.
    const keptHash = next.status === "failed" ? null : txHash;
    await getDb().execute(sql`
      update crypto_orders
      set status = ${next.status}, reason = ${next.reason}, tx_hash = ${keptHash}
      where id = ${order.id} and status <> 'confirmed'
    `);
    if (next.status === "frozen" && order.status !== "frozen") {
      await alertFrozenOrder(order.id, order.chain, txHash);
    }
    return { ...view(await loadOrder(order.id, userId)), granted: false };
  }
  const until = new Date(
    Date.now() + HIRE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  try {
    await getDb().transaction(async (tx) => {
      const used = await tx.execute<{ id: string }>(sql`
        select id from payments where chain = ${order.chain} and tx_hash = ${txHash}
      `);
      if (used[0]) throw new HttpError(409, "HASH_USED", "Already counted");
      await tx.execute(sql`
        update crypto_orders
        set status = 'confirmed', reason = null, tx_hash = ${txHash}
        where id = ${order.id} and status <> 'confirmed'
      `);
      await tx.execute(sql`
        insert into payments (purchase_id, amount_minor, currency, kind, chain, token, tx_hash, from_address)
        values (
          ${order.purchase_id}, ${order.amount_minor}, 'USD', 'charge',
          ${order.chain}, ${order.token}, ${txHash}, ${order.payer_address}
        )
      `);
      await tx.execute(sql`
        update purchases
        set status = 'paid', valid_until = ${until}
        where id = ${order.purchase_id} and status <> 'paid'
      `);
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, "HASH_USED", "Already counted");
  }
  return { ...view(await loadOrder(order.id, userId)), granted: true };
}

function checkInput(order: OrderRow, required: number) {
  return {
    requiredConfirmations: required,
    tokenContract: order.token_contract,
    recipient: order.recipient,
    payer: order.payer_address,
    amount: BigInt(order.token_amount),
    orderCreatedAt: Math.floor(new Date(order.created_at).getTime() / 1000),
  };
}

async function verifyEvmOrder(order: OrderRow, txHash: string) {
  const chain = chainById(order.chain);
  if (!chain) throw notFound();
  const snapshot = await readChain(order.chain, txHash as `0x${string}`);
  return verifyTransfer({
    ...checkInput(order, chain.confirmations),
    receipt: snapshot.receipt,
    blockTimestamp: snapshot.blockTimestamp,
    confirmations: snapshot.confirmations,
    // D380: verifyTransfer has already matched this to the transfer's sender.
    sanctioned: await isSanctionedAddress(order.payer_address),
  });
}

/** D384: the server reads the receipt itself; the sender must be the signed address. */
async function verifyNonEvmOrder(
  order: OrderRow,
  network: NonEvmNetworkId,
  txId: string,
) {
  const spec = nonEvmNetwork(network);
  if (!spec) throw notFound();
  const sanctioned = await isSanctionedAddress(order.payer_address);
  if (network === "tron") {
    const read = await readTron(txId);
    return verifyTronTransfer({
      ...checkInput(order, spec.confirmations),
      info: read.info,
      confirmations: read.confirmations,
      sanctioned,
    });
  }
  const read = await readSolana(txId);
  return verifySolanaTransfer({
    ...checkInput(order, spec.confirmations),
    tx: read.tx,
    confirmations: read.confirmations,
    sanctioned,
  });
}

/** True when the address is on the stored OFAC SDN crypto list (D380). */
export async function isSanctionedAddress(address: string): Promise<boolean> {
  const rows = await getDb().execute<{ address: string }>(sql`
    select address from sanctioned_addresses
    where address = ${normalizeAddress(address)}
    limit 1
  `);
  return rows.length > 0;
}

/**
 * The owner's signal for a frozen order. The buyer only sees "payment under
 * review"; nothing moves the money (PAYMENTS §4.5). The log carries the
 * order, not the address.
 */
async function alertFrozenOrder(
  orderId: string,
  chain: string,
  txHash: string,
) {
  logger.warn(
    { orderId, chain },
    "billing order frozen: sender on sanctions list",
  );
  try {
    await billingPorts().notifyPlatformOwners(
      "Payment frozen for review",
      [
        "A crypto payment was frozen: the sender is on the OFAC SDN list.",
        `Order: ${orderId}`,
        `Network: ${chain}`,
        `Transaction: ${txHash}`,
        "No plan was granted and no money was moved. The decision is yours.",
      ].join("\n"),
    );
  } catch (error) {
    logger.error({ err: error, orderId }, "frozen order alert failed");
  }
}

export type SanctionsRefresh = { stored: number; replaced: boolean };

/**
 * Daily refresh of the OFAC SDN crypto addresses (D380). The set is replaced
 * in one transaction. An empty or broken download keeps the old list, so a
 * bad fetch never clears the check.
 */
export async function refreshSanctionsList(
  fetchXml: () => Promise<string> = fetchOfacSdn,
): Promise<SanctionsRefresh> {
  const addresses = parseSdnCryptoAddresses(await fetchXml());
  if (addresses.length === 0) {
    logger.warn("sanctions refresh found no crypto addresses; list kept");
    return { stored: 0, replaced: false };
  }
  await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`delete from sanctioned_addresses where source = 'ofac_sdn'`,
    );
    for (let start = 0; start < addresses.length; start += 500) {
      const chunk = addresses.slice(start, start + 500);
      await tx.execute(sql`
        insert into sanctioned_addresses (address, currency, source, updated_at)
        values ${sql.join(
          chunk.map(
            (entry) =>
              sql`(${entry.address}, ${entry.currency}, 'ofac_sdn', now())`,
          ),
          sql`, `,
        )}
        on conflict (address) do update
        set currency = excluded.currency, updated_at = excluded.updated_at
      `);
    }
  });
  return { stored: addresses.length, replaced: true };
}

async function fetchOfacSdn(): Promise<string> {
  const url = process.env.OFAC_SDN_URL?.trim() || OFAC_SDN_URL;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new HttpError(
      502,
      "SANCTIONS_FETCH_FAILED",
      "The OFAC list did not load",
    );
  }
  return response.text();
}

export async function refreshHireOrder(
  userId: string,
  orderId: string,
): Promise<OrderView> {
  const order = await loadOrder(orderId, userId);
  if (order.status === "submitted" && order.tx_hash) {
    return confirmHireOrder(userId, orderId, order.tx_hash);
  }
  return view(order);
}

export async function recheckSubmittedOrders(): Promise<number> {
  const rows = await getDb().execute<{
    id: string;
    user_id: string;
    tx_hash: string;
  }>(sql`
    select id, user_id, tx_hash
    from crypto_orders
    where status = 'submitted' and tx_hash is not null
    limit 20
  `);
  let checked = 0;
  for (const row of rows) {
    await confirmHireOrder(row.user_id, row.id, row.tx_hash);
    checked += 1;
  }
  return checked;
}

export async function recordBillingInterest(input: {
  userId: string | null;
  email: string | null;
  token: string | null;
  chain: string | null;
}): Promise<void> {
  await getDb().execute(sql`
    insert into billing_interest (user_id, email, plan_code, token, chain)
    values (${input.userId}, ${input.email}, ${HIRE_PLAN}, ${input.token}, ${input.chain})
  `);
}
