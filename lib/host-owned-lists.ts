// The two public lists VRP Core §2 needs to decide whether a domain is
// host-owned: the Public Suffix List (its ICANN section) and ICANN's gTLD list
// (its Specification 13 entries). Read live, the way the spec's own verifier
// (vacationrentalprotocol.com/verify) reads them, and kept for six hours per
// function instance. null = a list could not be read: the caller treats the
// node as unknown and verifies nothing (Core §2, §9).
import {
  GTLDS_URL,
  type HostOwnedLists,
  icannRulesFromPsl,
  PSL_URL,
  specification13FromGtlds,
} from "./host-owned-domain.js";

export const HOST_OWNED_LISTS_TTL_MS = 6 * 60 * 60 * 1000;
export const HOST_OWNED_LISTS_TIMEOUT_MS = 5_000;

let cached: { lists: HostOwnedLists; at: number } | null = null;

/** Tests seed the cache so no fetch mock has to serve the two lists. */
export function primeHostOwnedLists(lists: HostOwnedLists | null): void {
  cached = lists ? { lists, at: Date.now() } : null;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HOST_OWNED_LISTS_TIMEOUT_MS) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

export async function loadHostOwnedLists(): Promise<HostOwnedLists | null> {
  if (cached && Date.now() - cached.at < HOST_OWNED_LISTS_TTL_MS) return cached.lists;
  const [psl, gtlds] = await Promise.all([fetchText(PSL_URL), fetchText(GTLDS_URL)]);
  const icannRules = psl === null ? null : icannRulesFromPsl(psl);
  let specification13Tlds: string[] | null = null;
  if (gtlds !== null) {
    try {
      specification13Tlds = specification13FromGtlds(JSON.parse(gtlds));
    } catch {
      specification13Tlds = null;
    }
  }
  if (!icannRules || !specification13Tlds) return null;
  const lists = { icannRules, specification13Tlds };
  cached = { lists, at: Date.now() };
  return lists;
}
