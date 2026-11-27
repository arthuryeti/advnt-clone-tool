import "server-only";

import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type DnsLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<LookupAddress[]>;

let testDnsLookup: DnsLookupFn | null = null;

/** Test hook so unit/contract tests can simulate DNS rebinding without touching real DNS. */
export function setSsrfDnsLookupForTests(fn: DnsLookupFn | null): void {
  testDnsLookup = fn;
}

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

/** Hosts explicitly permitted for local mock-server integration tests only (never cloud IMDS). */
export function getAllowedPrivateHostsFromEnv(): Set<string> {
  const raw = process.env.UNSAFE_ALLOW_PRIVATE_PROVIDER_HOSTS;
  if (!raw) return new Set();
  const entries = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0 && !METADATA_HOSTS.has(item));
  return new Set(entries);
}

function parseIpv4Int(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value * 256 + octet) >>> 0;
  }
  return value;
}

function inIpv4Cidr(ipInt: number, baseIp: string, prefix: number): boolean {
  const baseInt = parseIpv4Int(baseIp);
  if (baseInt === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isBlockedIpv4Int(ipInt: number): boolean {
  return (
    inIpv4Cidr(ipInt, "0.0.0.0", 8) || // Current network / unspecified
    inIpv4Cidr(ipInt, "10.0.0.0", 8) || // RFC1918 private
    inIpv4Cidr(ipInt, "100.64.0.0", 10) || // CGNAT RFC6598
    inIpv4Cidr(ipInt, "127.0.0.0", 8) || // Loopback
    inIpv4Cidr(ipInt, "169.254.0.0", 16) || // Link-local / IMDS
    inIpv4Cidr(ipInt, "172.16.0.0", 12) || // RFC1918 private
    inIpv4Cidr(ipInt, "192.0.0.0", 24) || // IETF protocol assignments
    inIpv4Cidr(ipInt, "192.0.2.0", 24) || // TEST-NET-1
    inIpv4Cidr(ipInt, "192.168.0.0", 16) || // RFC1918 private
    inIpv4Cidr(ipInt, "198.18.0.0", 15) || // Benchmarking
    inIpv4Cidr(ipInt, "198.51.100.0", 24) || // TEST-NET-2
    inIpv4Cidr(ipInt, "203.0.113.0", 24) || // TEST-NET-3
    inIpv4Cidr(ipInt, "224.0.0.0", 4) || // Multicast
    inIpv4Cidr(ipInt, "240.0.0.0", 4) // Reserved / broadcast
  );
}

function parseIpv6Hextets(ip: string): number[] | null {
  const withoutZone = ip.split("%")[0] ?? ip;
  // Convert trailing dotted-quad IPv4 (e.g. ::ffff:127.0.0.1) to two hex groups.
  let normalized = withoutZone;
  const lastColon = normalized.lastIndexOf(":");
  const tail = lastColon >= 0 ? normalized.slice(lastColon + 1) : "";
  if (tail.includes(".")) {
    const v4Int = parseIpv4Int(tail);
    if (v4Int === null) return null;
    const high = ((v4Int >>> 16) & 0xffff).toString(16);
    const low = (v4Int & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const sides = normalized.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(":").filter(Boolean) : [];
  const right = sides[1] ? sides[1].split(":").filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);
  if (sides.length === 1 && missing !== 0) return null;
  if (sides.length === 2 && missing < 1) return null;

  const groups = [
    ...left,
    ...Array.from({ length: Math.max(0, missing) }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return null;

  const result: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) return null;
    result.push(Number.parseInt(group, 16));
  }
  return result;
}

/**
 * Returns true if an IPv4 or IPv6 address (including IPv4-mapped IPv6 in dotted or hex form)
 * targets loopback, private, link-local, CGNAT, multicast, unspecified, or reserved space.
 */
export function isBlockedIp(rawIp: string): boolean {
  const cleaned =
    rawIp
      .trim()
      .replace(/^\[|\]$/gu, "")
      .split("%")[0] ?? "";
  const version = isIP(cleaned);
  if (version === 4) {
    const int = parseIpv4Int(cleaned);
    return int === null || isBlockedIpv4Int(int);
  }
  if (version === 6) {
    const hextets = parseIpv6Hextets(cleaned);
    if (!hextets) return true;

    const allZero = hextets.every((h) => h === 0);
    if (allZero) return true; // :: unspecified

    const isLoopback =
      hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1;
    if (isLoopback) return true; // ::1

    // IPv4-mapped ::ffff:0:0/96 (both ::ffff:127.0.0.1 and ::ffff:7f00:1)
    const isV4Mapped =
      hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
    if (isV4Mapped) {
      const v4Int = (((hextets[6] ?? 0) << 16) | (hextets[7] ?? 0)) >>> 0;
      return isBlockedIpv4Int(v4Int);
    }

    // IPv4-compatible ::/96
    const isV4Compat = hextets.slice(0, 6).every((h) => h === 0);
    if (isV4Compat) {
      const v4Int = (((hextets[6] ?? 0) << 16) | (hextets[7] ?? 0)) >>> 0;
      return isBlockedIpv4Int(v4Int);
    }

    // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
    if (
      hextets[0] === 0x0064 &&
      hextets[1] === 0xff9b &&
      hextets.slice(2, 6).every((h) => h === 0)
    ) {
      const v4Int = (((hextets[6] ?? 0) << 16) | (hextets[7] ?? 0)) >>> 0;
      return isBlockedIpv4Int(v4Int);
    }
    if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets[2] === 1) {
      return true;
    }

    const first = hextets[0] ?? 0;
    const second = hextets[1] ?? 0;
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 Unique Local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 Link-local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 Multicast
    if (first === 0x0100 && hextets.slice(1, 4).every((h) => h === 0)) {
      return true; // 100::/64 Discard-only
    }
    if (first === 0x2001 && second === 0x0db8) return true; // 2001:db8::/32 Docs
    return false;
  }
  return true;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname
    .trim()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.+$/u, "")
    .toLowerCase();
  if (!host) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    METADATA_HOSTS.has(host)
  ) {
    return true;
  }
  return false;
}

export function isHostInAllowlist(
  url: URL,
  allowlist: ReadonlySet<string>,
): boolean {
  const hostOnly = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const hostWithPort = url.port ? `${hostOnly}:${url.port}` : hostOnly;
  if (METADATA_HOSTS.has(hostOnly)) return false;
  return allowlist.has(hostWithPort) || allowlist.has(hostOnly);
}

export type AssertSafeRemoteUrlOptions = {
  allowHttp?: boolean;
  allowedPrivateHosts?: ReadonlySet<string>;
  lookupFn?: DnsLookupFn;
};

/**
 * Validates that a remote URL points to a safe external host (blocking loopback, private,
 * link-local, metadata, and DNS-rebound targets unless explicitly allowlisted for local tests).
 */
export async function assertSafeRemoteUrl(
  rawUrl: string,
  options: AssertSafeRemoteUrlOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Blocked remote URL: invalid URL.");
  }

  if (url.username || url.password) {
    throw new Error("Blocked remote URL: embedded credentials not allowed.");
  }

  const allowlist =
    options.allowedPrivateHosts ?? getAllowedPrivateHostsFromEnv();
  const explicitlyAllowed = isHostInAllowlist(url, allowlist);

  const allowHttp = options.allowHttp ?? explicitlyAllowed;
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error(`Blocked remote URL: unsupported scheme ${url.protocol}.`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (explicitlyAllowed) {
    return url;
  }

  if (isBlockedHostname(hostname)) {
    throw new Error(`Blocked remote URL host: ${hostname}.`);
  }

  if (isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) {
      throw new Error(`Blocked remote URL IP: ${hostname}.`);
    }
    return url;
  }

  const resolver: DnsLookupFn =
    options.lookupFn ?? testDnsLookup ?? ((host, opts) => lookup(host, opts));
  let records: LookupAddress[];
  try {
    records = await resolver(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve remote URL host: ${hostname}.`);
  }
  if (records.length === 0) {
    throw new Error(`No DNS records found for remote URL host: ${hostname}.`);
  }
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new Error(
        `Blocked remote URL host ${hostname}: resolved to restricted IP.`,
      );
    }
  }
  return url;
}
