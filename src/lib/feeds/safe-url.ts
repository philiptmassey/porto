import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export type PinnedAddress = { address: string; family: 4 | 6 };

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function inV4Range(address: number, base: string, maskBits: number): boolean {
  const shift = 32 - maskBits;
  return (address >>> shift) === (ipv4ToNumber(base) >>> shift);
}

function isPublicV4(address: string): boolean {
  const numeric = ipv4ToNumber(address);
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, bits]) => inV4Range(numeric, base, bits));
}

function ipv6ToBigInt(address: string): bigint | null {
  const normalized = address.toLowerCase().split("%", 1)[0];
  if (normalized.includes(".")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function inV6Range(value: bigint, base: bigint, bits: number): boolean {
  return value >> BigInt(128 - bits) === base >> BigInt(128 - bits);
}

function v6(base: string): bigint {
  return ipv6ToBigInt(base)!;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicV4(address);
  if (family !== 6) return false;

  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  // Accept globally routable unicast space only, excluding special-purpose blocks.
  if (!inV6Range(value, v6("2000::"), 3)) return false;
  const blocked: Array<[string, number]> = [
    ["2001::", 23], // protocol assignments and transition mechanisms
    ["2001:db8::", 32], // documentation
    ["2002::", 16], // 6to4
    ["3fff::", 20], // documentation
  ];
  return !blocked.some(([base, bits]) => inV6Range(value, v6(base), bits));
}

export function parseSafeHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Feed URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Feed URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Feed URLs cannot contain credentials");
  if (!url.hostname) throw new Error("Feed URL must include a hostname");
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error("Feed URL has an invalid port");
  return url;
}

export async function resolvePublicAddress(hostname: string): Promise<PinnedAddress> {
  hostname = hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicAddress(hostname)) throw new Error("Feed host resolves to a non-public address");
    return { address: hostname, family: literalFamily as 4 | 6 };
  }

  let records: Array<{ address: string; family: number }>;
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new Error("DNS lookup timed out")), 5_000); }),
    ]);
  } catch {
    throw new Error("Feed host could not be resolved");
  } finally {
    if (dnsTimer) clearTimeout(dnsTimer);
  }
  if (records.length === 0 || records.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Feed host resolves to a non-public address");
  }
  // Vercel deployments may have working IPv4 egress while IPv6 routes are unavailable.
  const first = records.find(({ family }) => family === 4) ?? records[0];
  return { address: first.address, family: first.family as 4 | 6 };
}
