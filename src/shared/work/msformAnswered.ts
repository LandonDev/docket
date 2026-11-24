/**
 * Who has not answered a Microsoft form (docs/agents/work-msforms.md "Who has
 * not answered"): a list he gives (People of the sector, or pasted
 * addresses) against the addresses in the answers, matched lower-cased. A
 * Team's member list is not read. Pure: the window and the host both use it.
 */

const ADDRESS = /[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[^\s<>(),;:"'.]+/g

export const normAddress = (email: string): string => email.trim().toLowerCase()

/** Every address in pasted text (one a line, commas, "Name <a@b.c>"), each once, in order. */
export function addressesIn(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.match(ADDRESS) ?? []) {
    const k = normAddress(m)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  return out
}

/** Of `list`, the addresses with no answer among `answered`, each once, in the list's order. */
export function notAnswered(answered: readonly string[], list: readonly string[]): string[] {
  const done = new Set(answered.map(normAddress))
  const seen = new Set<string>()
  return list.filter((e) => {
    const k = normAddress(e)
    if (!k || done.has(k) || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Someone on his list: a person of the sector by their addresses, or one pasted address. */
export interface ListedPerson {
  name?: string;
  emails: readonly string[];
}

/** Of the people on his list, those none of whose addresses answered, each once, with the address to write to. */
export function missingOf(answered: readonly string[], list: readonly ListedPerson[]): { name?: string; email: string }[] {
  const done = new Set(answered.map(normAddress));
  const seen = new Set<string>();
  const out: { name?: string; email: string }[] = [];
  for (const p of list) {
    const emails = p.emails.map(normAddress).filter(Boolean);
    if (!emails.length || emails.some((e) => done.has(e) || seen.has(e))) continue;
    for (const e of emails) seen.add(e);
    out.push({ ...(p.name ? { name: p.name } : {}), email: emails[0]! });
  }
  return out;
}
