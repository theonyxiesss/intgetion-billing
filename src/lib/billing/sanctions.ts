/**
 * Crypto addresses from the open OFAC SDN list (PAYMENTS §4.5, D380).
 *
 * The public `sdn.xml` lists them as identity documents of a sanctioned
 * entry: `<idType>Digital Currency Address - ETH</idType>` with the address
 * in `<idNumber>`. Only those rows are read; names and everything else stay
 * out of the database.
 */

/** Public SDN export. Overridable for a mirror, never a secret. */
export const OFAC_SDN_URL = "https://www.treasury.gov/ofac/downloads/sdn.xml";

const ID_TYPE_PREFIX = "Digital Currency Address - ";

export type SanctionedAddress = { address: string; currency: string };

/** EVM addresses compare case-insensitively; other chains keep their case. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  return /^0x[0-9a-fA-F]+$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function tagText(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() ?? null;
}

/** Every digital currency address in the SDN XML, de-duplicated. */
export function parseSdnCryptoAddresses(xml: string): SanctionedAddress[] {
  const found = new Map<string, SanctionedAddress>();
  for (const [block] of xml.matchAll(/<id>[\s\S]*?<\/id>/g)) {
    const type = tagText(block, "idType");
    const number = tagText(block, "idNumber");
    if (!type?.startsWith(ID_TYPE_PREFIX) || !number) continue;
    const currency = type.slice(ID_TYPE_PREFIX.length).trim();
    const address = normalizeAddress(number);
    if (!currency || !address) continue;
    found.set(address, { address, currency });
  }
  return [...found.values()];
}
