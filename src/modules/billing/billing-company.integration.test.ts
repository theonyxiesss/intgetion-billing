import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { billingForCompany } from "./service";

const userId = randomUUID();
const otherUserId = randomUUID();
const firstCompanyId = randomUUID();
const secondCompanyId = randomUUID();
const purchaseId = randomUUID();

async function seed() {
  await getDb().execute(sql`
    insert into public.users (id, auth_uid, terms_accepted_at, terms_version)
    values (${userId}, ${randomUUID()}, now(), 'integration'),
           (${otherUserId}, ${randomUUID()}, now(), 'integration')
  `);
  await getDb().execute(sql`
    insert into public.companies (id, name, slug, status, created_by)
    values (${firstCompanyId}, 'Billing Company One', ${`billing-${firstCompanyId.slice(0, 8)}`}, 'verified', ${userId}),
           (${secondCompanyId}, 'Billing Company Two', ${`billing-${secondCompanyId.slice(0, 8)}`}, 'verified', ${userId})
  `);
  await getDb().execute(sql`
    insert into public.company_members (company_id, user_id, role)
    values (${firstCompanyId}, ${userId}, 'owner'),
           (${secondCompanyId}, ${userId}, 'member')
  `);
  await getDb().execute(sql`
    insert into public.purchases (id, company_id, plan_code, status, valid_until)
    values (${purchaseId}, ${firstCompanyId}, 'company_team', 'paid', now() + interval '20 days')
  `);
}

beforeAll(seed);
afterAll(async () => {
  await getDb().execute(
    sql`delete from public.purchases where id = ${purchaseId}`,
  );
  await getDb().execute(
    sql`delete from public.companies where id in (${firstCompanyId}, ${secondCompanyId})`,
  );
  await getDb().execute(
    sql`delete from public.users where id in (${userId}, ${otherUserId})`,
  );
});

describe("company billing context in Postgres", () => {
  it("returns only the selected member company's active plan", async () => {
    await expect(
      billingForCompany(userId, firstCompanyId),
    ).resolves.toMatchObject({
      plan: "team",
      teamUntil: expect.any(String),
    });
    await expect(billingForCompany(userId, secondCompanyId)).resolves.toEqual({
      plan: "start",
      hires: [],
      teamUntil: null,
    });
  });

  it("does not disclose company billing to a non-member", async () => {
    await expect(
      billingForCompany(otherUserId, firstCompanyId),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});
