import { describe, expect, it } from "vitest";
import {
  decodeEscrowData,
  encodeEscrowData,
  ESCROW_NETWORKS,
  ESCROW_TYPE,
  escrowDetails,
  readEscrow,
  type ContractReader,
} from "./escrow";

// Synthetic addresses for tests only; none of them is a real wallet or token.
const CLIENT = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
const RESOLVER = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x4444444444444444444444444444444444444444";
const WRAPPED = "0x5555555555555555555555555555555555555555";
const ESCROW = "0x6666666666666666666666666666666666666666";

describe("Smart Invoice escrow helpers (TZ 43)", () => {
  it("keeps the factory checked on Base Sepolia (TZ 43 §12)", () => {
    expect(ESCROW_NETWORKS["base-sepolia"]).toEqual({
      chainId: 84532,
      factory: "0x851e59a39571e599954702f0e4996bf838d9c863",
    });
  });

  it("names the escrow type as the factory does: ascii, right-padded", () => {
    expect(ESCROW_TYPE).toBe(
      "0x657363726f770000000000000000000000000000000000000000000000000000",
    );
  });

  it("binds a stable, order-specific hash and no personal data", () => {
    expect(escrowDetails("order-1")).toBe(escrowDetails("order-1"));
    expect(escrowDetails("order-1")).not.toBe(escrowDetails("order-2"));
    expect(escrowDetails("order-1")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("encodes `_data` in the order the contract decodes it", () => {
    const data = {
      client: CLIENT,
      resolverType: 0,
      resolver: RESOLVER,
      token: TOKEN,
      terminationTime: BigInt(1_800_000_000),
      details: escrowDetails("order-1"),
      wrappedNativeToken: WRAPPED,
      requireVerification: false,
      factory: ESCROW_NETWORKS["base-sepolia"].factory,
    } as const;
    const decoded = decodeEscrowData(encodeEscrowData(data));
    expect({
      ...decoded,
      client: decoded.client.toLowerCase(),
      resolver: decoded.resolver.toLowerCase(),
      token: decoded.token.toLowerCase(),
      wrappedNativeToken: decoded.wrappedNativeToken.toLowerCase(),
      factory: decoded.factory.toLowerCase(),
    }).toEqual(data);
  });

  it("reads every field and the token balance through one reader", async () => {
    const values: Record<string, unknown> = {
      client: CLIENT.toUpperCase().replace("0X", "0x"),
      provider: PROVIDER,
      resolverType: 0,
      resolver: RESOLVER,
      token: TOKEN,
      terminationTime: BigInt(1_800_000_000),
      resolutionRate: BigInt(20),
      details: escrowDetails("order-1"),
      getAmounts: [BigInt(50_000_000)],
      locked: false,
      milestone: BigInt(0),
    };
    const calls: string[] = [];
    const reader: ContractReader = {
      async readContract({ address, functionName, args }) {
        calls.push(`${address}:${functionName}`);
        if (functionName === "balanceOf") {
          expect(address).toBe(TOKEN);
          expect(args).toEqual([ESCROW]);
          return BigInt(50_000_000);
        }
        expect(address).toBe(ESCROW);
        return values[functionName];
      },
    };
    const snapshot = await readEscrow(reader, ESCROW);
    expect(snapshot).toEqual({
      client: CLIENT,
      provider: PROVIDER,
      resolverType: 0,
      resolver: RESOLVER,
      token: TOKEN,
      terminationTime: BigInt(1_800_000_000),
      resolutionRate: BigInt(20),
      details: escrowDetails("order-1"),
      amounts: [BigInt(50_000_000)],
      locked: false,
      milestone: BigInt(0),
      balance: BigInt(50_000_000),
    });
    expect(calls).toHaveLength(12);
  });

  it("fails when the address is not an escrow contract", async () => {
    const reader: ContractReader = {
      async readContract() {
        throw new Error("execution reverted");
      },
    };
    await expect(readEscrow(reader, ESCROW)).rejects.toThrow("reverted");
  });
});
