import { createHash } from 'node:crypto'
import { unzip, unzipSync, type Unzipped } from 'fflate'
import type { WorkCtx } from '../modules'

/**
 * SharePoint's own touch (docs/agents/work-files.md "Saved is not uploaded"). An Office file OneDrive uploads into a
 * Teams library is written again by SharePoint about half a second later, and comes back down: its columns and content
 * type as custom XML, its properties, a `[trash]` of its own, and the relationships and content types naming them
 * (seen 2026-11-24: a .docx of 12,524 bytes came back as 21,001, its document part byte for byte the same). By version
 * or by its bytes' hash that is a change made there, and a save would stop on it. The body is the file but what
 * SharePoint writes: a file whose body is as we last read or wrote it was changed by no one, and our save goes over it.
 */

/**
 * What SharePoint was seen to write (the .docx of 2026-11-24 and the blank of 1.0.371), and nothing more: anything
 * else that differs, a link's target, a title, a part's content type, is someone's edit and stops the save.
 * - Its own parts, left out whole: the columns and content type schema (`customXml/`), its properties
 *   (`docProps/custom.xml`) and its `[trash]/`.
 * - The parts that name them, kept but for the entries naming those: each `.rels` part's relationships (the package's
 *   own `_rels/.rels` among them: a file with no properties gets a link to SharePoint's there) and
 *   `[Content_Types].xml`'s overrides. A default for an extension no other part has names nothing anyone made.
 * - `docProps/core.xml`, kept but for a save's own bookkeeping: when, by whom, the how-manyth.
 * Each kept part is read as its entries, sorted, so the same facts written another way are the same body.
 */
const SERVICE_PARTS = /^(customXml\/.*|docProps\/custom\.xml|\[trash\]\/.*)$/
const RELS = /^(.*\/)?_rels\/[^/]*\.rels$/
const BOOKKEEPING = new Set(['dcterms:modified', 'cp:lastModifiedBy', 'cp:revision'])

const attrsOf = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1]!, m[2] ?? m[3] ?? '']))
const tagsOf = (xml: string, name: string): Record<string, string>[] => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}\\b([^>]*?)/?>`, 'g'))].map((m) => attrsOf(m[1]!))

/** The part a relationship of a `.rels` part points at, from the package's root (`word/../customXml/item1.xml` → `customXml/item1.xml`). */
function targetOf(rels: string, target: string): string {
  const from = target.startsWith('/') ? [] : rels.replace(/_rels\/[^/]*\.rels$/, '').split('/').filter(Boolean)
  for (const step of target.split('/')) {
    if (step === '..') from.pop()
    else if (step && step !== '.') from.push(step)
  }
  return from.join('/')
}

/** A part as the body reads it: SharePoint's entries out of the parts that name them, everything else its bytes. */
function partOf(name: string, data: Uint8Array, names: string[]): string | Uint8Array {
  const xml = (): string => Buffer.from(data).toString('utf8')
  if (RELS.test(name)) {
    return tagsOf(xml(), 'Relationship')
      .filter((a) => a.TargetMode === 'External' || !SERVICE_PARTS.test(targetOf(name, a.Target ?? '')))
      .map((a) => [a.Id, a.Type, a.Target, a.TargetMode ?? ''].join('\u0001'))
      .sort()
      .join('\n')
  }
  if (name === '[Content_Types].xml') {
    const exts = new Set(names.map((n) => n.slice(n.lastIndexOf('.') + 1).toLowerCase()))
    const defaults = tagsOf(xml(), 'Default').filter((a) => exts.has((a.Extension ?? '').toLowerCase())).map((a) => `default\u0001${(a.Extension ?? '').toLowerCase()}\u0001${a.ContentType}`)
    const overrides = tagsOf(xml(), 'Override').filter((a) => !SERVICE_PARTS.test((a.PartName ?? '').replace(/^\//, ''))).map((a) => `override\u0001${a.PartName}\u0001${a.ContentType}`)
    return [...defaults, ...overrides].sort().join('\n')
  }
  if (name === 'docProps/core.xml') {
    return [...xml().matchAll(/<([\w:]+)(?:\s[^>]*)?>([^<]*)<\/\1>/g)]
      .filter((m) => !BOOKKEEPING.has(m[1]!))
      .map((m) => `${m[1]}\u0001${m[2]}`)
      .sort()
      .join('\n')
  }
  return data
}

/** The hash of a package's parts but SharePoint's, sorted by name. */
function hashParts(parts: Unzipped): string {
  const names = Object.keys(parts).sort()
  const h = createHash('sha256')
  for (const name of names) {
    const part = partOf(name, parts[name]!, names)
    // a `.rels` part naming SharePoint's alone (the blank's document had none until SharePoint linked its columns)
    if (part === '' && RELS.test(name)) continue
    h.update(name).update('\0').update(part).update('\0')
  }
  return `parts:${h.digest('hex')}`
}

/** A hash of a file's body: an Office file's parts as `partOf` reads them, sorted by name; any other file's every byte. */
export function bodyOf(data: Uint8Array): string {
  if (data[0] === 0x50 && data[1] === 0x4b) {
    try {
      return hashParts(unzipSync(data, { filter: (f) => !SERVICE_PARTS.test(f.name) }))
    } catch {
      // not a package after all: its bytes are its body
    }
  }
  return createHash('sha256').update(data).digest('hex')
}

/**
 * The same body hash, made off the event loop: an Office file's parts are inflated in a worker (fflate's `unzip`), so
 * a copy of a large deck never holds the host while it is read. Its bytes are the ones already in hand.
 */
export async function bodyOfAsync(data: Uint8Array): Promise<string> {
  if (data[0] === 0x50 && data[1] === 0x4b) {
    const parts = await new Promise<Unzipped | null>((done) => unzip(data, { filter: (f) => !SERVICE_PARTS.test(f.name) }, (err, out) => done(err ? null : out)))
    if (parts) return hashParts(parts)
  }
  return createHash('sha256').update(data).digest('hex')
}

type FileAt = { workspace_id: string; host: string; path: string }

/** The body of a file of another computer as we just read or wrote it. */
export function keepBody(ctx: Pick<WorkCtx, 'db'>, r: FileAt, data: Uint8Array): void {
  keepBodyHash(ctx, r, bodyOf(data))
}

/** A body hash already made (`bodyOfAsync`), kept as `keepBody` keeps one. */
export function keepBodyHash(ctx: Pick<WorkCtx, 'db'>, r: FileAt, body: string): void {
  ctx.db.prepare(`INSERT INTO work_files_bodies (workspace_id, host, path, body) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, host, path) DO UPDATE SET body = excluded.body`).run(r.workspace_id, r.host, r.path, body)
}

/** Whether a file found changed there has the body we last read or wrote: SharePoint's touch alone, no one's edit. */
export function sameBody(ctx: Pick<WorkCtx, 'db'>, r: FileAt, data: Uint8Array): boolean {
  const kept = ctx.db.prepare(`SELECT body FROM work_files_bodies WHERE workspace_id = ? AND host = ? AND path = ?`).get(r.workspace_id, r.host, r.path) as { body: string } | undefined
  return !!kept && kept.body === bodyOf(data)
}
