// What the drawing, chart and picture writers' tests share: the corpus, and the check that a patch
// changed, added and removed exactly the parts it says and left every other entry's bytes alone.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { expect } from 'vitest'
import type { PackageReport } from './drawings'
import { readText, readZip, writeZip, type Entry, type Zip } from './zip'

export const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, '../harness/corpus', name)))
export const xml = (bytes: Uint8Array, part: string) => readText(readZip(bytes), part)
export const names = (bytes: Uint8Array) => [...readZip(bytes).byName.keys()]

/** A copy of a package with some parts' text replaced or added. */
export function withParts(bytes: Uint8Array, changes: Record<string, string>, added: Record<string, string> = {}) {
  const encode = (parts: Record<string, string>) =>
    new Map(Object.entries(parts).map(([part, text]) => [part, new TextEncoder().encode(text)]))
  return writeZip(readZip(bytes), encode(changes), new Set(), encode(added))
}

function localRecord(z: Zip, entry: Entry): Buffer {
  const view = new DataView(z.buf.buffer, z.buf.byteOffset, z.buf.byteLength)
  const at = entry.localOffset
  let end = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true) + entry.compSize
  if (entry.flags & 8) end += view.getUint32(end, true) === 0x08074b50 ? 16 : 12
  return Buffer.from(z.buf.subarray(at, end))
}

/** Parses a part and fails on anything xmldom calls an error: the part is well-formed XML. */
export function parsed(text: string) {
  const faults: string[] = []
  const doc = new DOMParser({ onError: (level, message) => void (level !== 'warning' && faults.push(message)) }).parseFromString(text, 'application/xml')
  expect(faults).toEqual([])
  return doc.documentElement!
}

export interface Expected {
  changed?: string[]
  added?: string[]
  removed?: string[]
}

/**
 * Holds a patch to its report: the parts named are the parts that differ, every other entry's
 * local record is the same bytes, an empty report is the same bytes object, and every part written
 * is well-formed.
 */
export function held(input: Uint8Array, output: Uint8Array, report: PackageReport, expected: Expected) {
  const { changed = [], added = [], removed = [] } = expected
  expect(report.partsChanged.toSorted()).toEqual(changed.toSorted())
  expect(report.partsAdded.toSorted()).toEqual(added.toSorted())
  expect(report.partsRemoved.toSorted()).toEqual(removed.toSorted())
  const before = readZip(input)
  const after = readZip(output)
  expect([...after.byName.keys()].toSorted()).toEqual(
    [...before.byName.keys()].filter((part) => !removed.includes(part)).concat(added).toSorted()
  )
  for (const entry of before.entries) {
    if (removed.includes(entry.name)) continue
    expect(localRecord(before, entry).equals(localRecord(after, after.byName.get(entry.name)!)), entry.name).toBe(
      !changed.includes(entry.name)
    )
  }
  if (!changed.length && !added.length && !removed.length) expect(output).toBe(input)
  for (const part of [...changed, ...added]) if (/\.(xml|rels)$/.test(part)) parsed(readText(after, part))
}

/** Keeps a proof workbook and what it should hold, when a proof folder is named. */
export function keep(env: string, name: string, bytes: Uint8Array, manifest: unknown) {
  const dir = process.env[env]
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name + '.xlsx'), bytes)
  writeFileSync(join(dir, name + '.json'), JSON.stringify(manifest, null, 2) + '\n')
}
