import { createHash } from 'node:crypto'

/**
 * A document's text as a word an agent hands back with its rewrite (docs/agents/work-docs.md "The tools"): `doc_read`
 * answers it with the text it read, and the service's write checks it against the live text in the same tick it
 * writes. Loaded by the service's entry too: node only.
 */
export const revisionOf = (markdown: string): string => `r${createHash('sha256').update(markdown).digest('hex').slice(0, 16)}`
