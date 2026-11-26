/**
 * A GitHub repo renamed keeps its id, and GitHub sends the old slug on to the new one, so a
 * checkout whose `origin` still names the old slug is the same repo as one that names the new.
 * Every match of `owner/name` (the linker, a far start, the clients' pairs, a repo asked for by
 * name) compares keys from here, never the raw slug.
 */
const RENAMED: Readonly<Record<string, string>> = {
  'landondev/temp-code': 'landondev/docket'
}

/** `LandonDev/Temp-Code` → `landondev/docket`: trimmed, lowercase, a renamed repo under its new slug; null for none. */
export function repoKey(repo: string | null | undefined): string | null {
  const key = repo?.trim().toLowerCase()
  if (!key) return null
  return RENAMED[key] ?? key
}
