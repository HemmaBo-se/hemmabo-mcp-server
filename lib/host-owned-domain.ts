/**
 * Host-owned domain (VRP Core §2, vrp-spec ADR 0009): a node is a domain
 * registered for the host, never a name under another party's domain.
 * `canonical_domain` MUST be
 *   1. lowercase ASCII, internationalized labels in A-label (xn--) form, no
 *      trailing dot;
 *   2. its own registrable domain under the Public Suffix List algorithm using
 *      only the ICANN section (rules compared in A-label form; the default rule
 *      `*` where none matches). The PRIVATE section does not count;
 *   3. not under a brand or closed top-level domain: ICANN's gTLD list entries
 *      with `"specification13": true`, plus `booking` and `hotels`.
 *
 * So `villa.airbnb.com`, `villa.wixsite.com`, `villa.hemmabo.com` and
 * `airbnb.villaakerlyckan.se` are never a node; `villaakerlyckan.se` and
 * `example.co.uk` are. Same algorithm and reason codes as vrp-spec
 * scripts/verify-host-domain.mjs `checkHostOwned`, pinned by the spec's
 * host_owned and real_world vectors in src/vrp-host-owned-node.contract.test.ts.
 */

/** Core §2: closed top-level domains the gTLD list does not mark. Changed only by a vrp-spec ADR. */
export const CLOSED_TLDS: readonly string[] = ["booking", "hotels"];

export const PSL_URL = "https://publicsuffix.org/list/public_suffix_list.dat";
export const GTLDS_URL = "https://www.icann.org/resources/registries/gtlds/v2/gtlds.json";

export interface HostOwnedLists {
  /** The ICANN section of the Public Suffix List, one rule per entry. */
  icannRules: readonly string[];
  /** Top-level domains with `"specification13": true` in ICANN's gTLD list. */
  specification13Tlds: readonly string[];
}

export type HostOwnedReason = "malformed_domain" | "public_suffix" | "not_host_owned" | "closed_tld";

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const ASCII = /^[ -~]*$/; // printable ASCII: a rule label needs no A-label conversion

/** A rule label in A-label form; "*" stays a wildcard. */
function toALabel(label: string): string {
  if (label === "*" || ASCII.test(label)) return label;
  return new URL(`http://${label}`).hostname;
}

/**
 * Public Suffix List algorithm (https://publicsuffix.org/list/): the prevailing
 * rule is an exception rule if one matches, else the matching rule with the
 * most labels, else the default rule "*". Returns the suffix's label count.
 */
function publicSuffixLength(labels: string[], rules: readonly string[]): number {
  let longest = 1;
  for (const raw of rules) {
    const exception = raw.startsWith("!");
    const rule = (exception ? raw.slice(1) : raw).split(".").map(toALabel);
    if (rule.length > labels.length) continue;
    const offset = labels.length - rule.length;
    if (!rule.every((l, i) => l === "*" || l === labels[offset + i])) continue;
    if (exception) return rule.length - 1;
    longest = Math.max(longest, rule.length);
  }
  return longest;
}

/** The registrable domain of `host` under `rules`, or null if `host` is a public suffix. */
export function registrableDomain(host: string, rules: readonly string[]): string | null {
  const labels = host.split(".");
  const suffix = publicSuffixLength(labels, rules);
  return labels.length > suffix ? labels.slice(-(suffix + 1)).join(".") : null;
}

/** Core §2: null when `domain` may be a node's canonical_domain, else the reason it may not. */
export function checkHostOwned(domain: string, lists: HostOwnedLists): HostOwnedReason | null {
  if (typeof domain !== "string" || domain.length === 0 || domain.length > 253) return "malformed_domain";
  const labels = domain.split(".");
  if (!labels.every((l) => LABEL.test(l))) return "malformed_domain";
  const registrable = registrableDomain(domain, lists.icannRules);
  if (registrable === null) return "public_suffix";
  if (registrable !== domain) return "not_host_owned";
  const tld = labels[labels.length - 1];
  if (lists.specification13Tlds.includes(tld) || CLOSED_TLDS.includes(tld)) return "closed_tld";
  return null;
}

/** The ICANN section's rules from the Public Suffix List file, or null if the section is missing. */
export function icannRulesFromPsl(text: string): string[] | null {
  const lines = text.split("\n");
  const begin = lines.findIndex((l) => l.includes("===BEGIN ICANN DOMAINS==="));
  const end = lines.findIndex((l) => l.includes("===END ICANN DOMAINS==="));
  if (begin < 0 || end < begin) return null;
  const rules = lines
    .slice(begin + 1, end)
    .map((l) => l.trim().split(/\s/)[0])
    .filter((l) => l.length > 0 && !l.startsWith("//"));
  return rules.length > 0 ? rules : null;
}

/** The Specification 13 top-level domains from ICANN's gTLD list JSON, or null if it has no list. */
export function specification13FromGtlds(json: unknown): string[] | null {
  const gtlds = (json as { gTLDs?: unknown } | null)?.gTLDs;
  if (!Array.isArray(gtlds) || gtlds.length === 0) return null;
  return gtlds
    .filter((g) => (g as { specification13?: unknown })?.specification13 === true)
    .map((g) => String((g as { gTLD?: unknown }).gTLD ?? "").toLowerCase())
    .filter((t) => t.length > 0);
}
