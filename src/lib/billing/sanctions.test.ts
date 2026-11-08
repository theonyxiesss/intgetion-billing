import { describe, expect, it } from "vitest";
import { normalizeAddress, parseSdnCryptoAddresses } from "./sanctions";

// Shaped like the public sdn.xml. Made-up entries, not real OFAC records.
const SDN_FIXTURE = `<?xml version="1.0" standalone="yes"?>
<sdnList>
  <sdnEntry>
    <uid>1</uid>
    <lastName>FIXTURE PERSON ONE</lastName>
    <sdnType>Individual</sdnType>
    <idList>
      <id>
        <uid>11</uid>
        <idType>Digital Currency Address - ETH</idType>
        <idNumber>0xAbCdEf0000000000000000000000000000000001</idNumber>
      </id>
      <id>
        <uid>12</uid>
        <idType>Passport</idType>
        <idNumber>P1234567</idNumber>
        <idCountry>Nowhere</idCountry>
      </id>
      <id>
        <uid>13</uid>
        <idType>Digital Currency Address - XBT</idType>
        <idNumber>1FixtureBitcoinAddressCaseKept</idNumber>
      </id>
    </idList>
  </sdnEntry>
  <sdnEntry>
    <uid>2</uid>
    <lastName>FIXTURE COMPANY TWO</lastName>
    <sdnType>Entity</sdnType>
    <idList>
      <id>
        <uid>21</uid>
        <idType>Digital Currency Address - USDT</idType>
        <idNumber>0xabcdef0000000000000000000000000000000001</idNumber>
      </id>
      <id>
        <uid>22</uid>
        <idType>Digital Currency Address - ETH</idType>
        <idNumber>0x00000000000000000000000000000000000000Ff</idNumber>
      </id>
    </idList>
  </sdnEntry>
</sdnList>`;

describe("OFAC SDN crypto addresses (D380)", () => {
  it("takes only digital currency addresses, not names or other documents", () => {
    const list = parseSdnCryptoAddresses(SDN_FIXTURE);
    expect(list.map((entry) => entry.address).sort()).toEqual(
      [
        "0x00000000000000000000000000000000000000ff",
        "0xabcdef0000000000000000000000000000000001",
        "1FixtureBitcoinAddressCaseKept",
      ].sort(),
    );
    const stored = JSON.stringify(list);
    expect(stored).not.toContain("FIXTURE PERSON");
    expect(stored).not.toContain("FIXTURE COMPANY");
    expect(stored).not.toContain("P1234567");
    expect(stored).not.toContain("Passport");
  });

  it("keeps the currency label and lower-cases EVM addresses only", () => {
    const list = parseSdnCryptoAddresses(SDN_FIXTURE);
    const btc = list.find((entry) => entry.currency === "XBT");
    expect(btc?.address).toBe("1FixtureBitcoinAddressCaseKept");
    expect(normalizeAddress(" 0xABC ")).toBe("0xabc");
    expect(normalizeAddress("TFixtureTronCase")).toBe("TFixtureTronCase");
  });

  it("de-duplicates the same EVM address written in two cases", () => {
    const list = parseSdnCryptoAddresses(SDN_FIXTURE);
    expect(
      list.filter(
        (entry) =>
          entry.address === "0xabcdef0000000000000000000000000000000001",
      ),
    ).toHaveLength(1);
  });

  it("finds nothing in a page without the list", () => {
    expect(parseSdnCryptoAddresses("<html>maintenance</html>")).toEqual([]);
    expect(parseSdnCryptoAddresses("")).toEqual([]);
  });
});
