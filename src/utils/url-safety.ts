import dns from 'dns';

/**
 * SSRF guard for the Advanced Automation `webhook_call` action — the only
 * place in this codebase where server-side code makes an HTTP request to a
 * URL a tenant user supplies (Manager+/Admin, per automation.* RBAC, but
 * "trusted to build an automation" is not the same as "trusted to probe
 * internal infrastructure"). Resolves the hostname, validates EVERY
 * resolved address (not just the first) against loopback/private/
 * link-local/cloud-metadata ranges, and returns a `lookup` function that
 * PINS the actual connection to the address already validated here —
 * re-checking the hostname string a second time immediately before
 * connecting is not enough on its own, since a sufficiently-timed DNS
 * rebinding attack (the domain resolves publicly at validation time, then
 * to a private address by the time the real connection happens) can beat a
 * check-then-separately-resolve sequence. Pinning closes that race: axios
 * is handed the already-validated IP directly (via its own documented
 * `lookup` config option — confirmed by reading axios's Node HTTP adapter
 * directly, `node_modules/axios/lib/adapters/http.js`, which reads
 * `config.lookup` and passes it straight to `http(s).request`'s own
 * `lookup` option), so the TCP connection never performs its own,
 * separately-timed DNS resolution at all.
 *
 * Caller is expected to: (1) call this once per webhook_call attempt
 * (including every retry — DNS can legitimately change between a save-time
 * check, potentially days earlier, and now), (2) on `safe:false`, fail the
 * action with a GENERIC user-facing message ("This webhook URL is not
 * allowed") — `reason` here is for server-side logs only, never echoed back
 * into a run's own visible result/error text, per the "don't leak DNS/IP
 * resolution details" requirement.
 */

export type SafeUrlCheck =
  | { safe: true; lookup: (hostname: string, options: unknown) => Promise<[string, number]> }
  | { safe: false; reason: string };

function parseIPv4ToBytes(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts;
}

const BLOCKED_V4_CIDRS = [
  '0.0.0.0/8',        // "this network" — meaningless as a real destination
  '10.0.0.0/8',        // RFC1918 private
  '127.0.0.0/8',        // loopback
  '169.254.0.0/16',     // link-local — includes the cloud-metadata address (169.254.169.254)
  '172.16.0.0/12',       // RFC1918 private
  '192.168.0.0/16',      // RFC1918 private
];

function ipv4InCidr(ipBytes: number[], cidr: string): boolean {
  const [rangeIp, bitsStr] = cidr.split('/');
  const rangeBytes = parseIPv4ToBytes(rangeIp)!;
  const bits = parseInt(bitsStr, 10);
  const ipInt = (ipBytes[0] << 24) | (ipBytes[1] << 16) | (ipBytes[2] << 8) | ipBytes[3];
  const rangeInt = (rangeBytes[0] << 24) | (rangeBytes[1] << 16) | (rangeBytes[2] << 8) | rangeBytes[3];
  const mask = bits === 0 ? 0 : (~0 << (32 - bits));
  return (ipInt & mask) === (rangeInt & mask);
}

function isBlockedIPv4(ip: string): boolean {
  const bytes = parseIPv4ToBytes(ip);
  if (!bytes) return true; // malformed — fail closed, never treat as safe
  return BLOCKED_V4_CIDRS.some((cidr) => ipv4InCidr(bytes, cidr));
}

/** Expands a textual IPv6 address (including `::` compression and an
 * IPv4-mapped tail like `::ffff:192.168.1.1`) into its 16 raw bytes — Node
 * has no built-in "parse IPv6 to bytes" utility, and CIDR-range checks need
 * real bytes, not the string form. */
function parseIPv6ToBytes(ip: string): number[] | null {
  const v4MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedMatch) {
    const v4 = parseIPv4ToBytes(v4MappedMatch[1]);
    if (!v4) return null;
    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...v4];
  }

  const doubleColonIdx = ip.indexOf('::');
  let headParts: string[];
  let tailParts: string[];
  if (doubleColonIdx !== -1) {
    const head = ip.slice(0, doubleColonIdx);
    const tail = ip.slice(doubleColonIdx + 2);
    headParts = head ? head.split(':') : [];
    tailParts = tail ? tail.split(':') : [];
  } else {
    headParts = ip.split(':');
    tailParts = [];
  }
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const allParts = [...headParts, ...Array(missing).fill('0'), ...tailParts];
  if (allParts.length !== 8) return null;

  const bytes: number[] = [];
  for (const part of allParts) {
    const val = parseInt(part || '0', 16);
    if (Number.isNaN(val) || val < 0 || val > 0xffff) return null;
    bytes.push((val >> 8) & 0xff, val & 0xff);
  }
  return bytes;
}

function isBlockedIPv6(bytes: number[]): boolean {
  // ::1 — loopback
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  // fe80::/10 — link-local (first byte 0xfe, second byte's top 2 bits '10')
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // fc00::/7 — unique local (IPv6's RFC1918-equivalent private space)
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  // ::ffff:0:0/96 — IPv4-mapped: unwrap and re-check against the v4 ranges,
  // never skipped (a naive check that only inspects the IPv6 form misses
  // this entirely).
  const isV4Mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isV4Mapped) {
    return isBlockedIPv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  return false;
}

export async function resolveAndPinSafeUrl(rawUrl: string): Promise<SafeUrlCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Malformed URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Unsupported scheme "${parsed.protocol}"` };
  }

  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(parsed.hostname, { all: true, verbatim: true });
  } catch (err) {
    return { safe: false, reason: `DNS resolution failed: ${(err as Error).message}` };
  }
  if (addresses.length === 0) {
    return { safe: false, reason: 'Hostname resolved to no addresses' };
  }

  for (const { address, family } of addresses) {
    const blocked = family === 4
      ? isBlockedIPv4(address)
      : (() => { const b = parseIPv6ToBytes(address); return !b || isBlockedIPv6(b); })();
    if (blocked) {
      return { safe: false, reason: `Resolved address ${address} is in a disallowed range` };
    }
  }

  // Pin to the FIRST validated address — every resolved address was already
  // confirmed safe above, so any one of them is a valid, consistent choice;
  // the point of pinning is that whichever one we pick, the real connection
  // uses exactly that address, not a fresh (and potentially different,
  // rebound) resolution performed later.
  const pinned = addresses[0];
  return {
    safe: true,
    lookup: async () => [pinned.address, pinned.family],
  };
}
