import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MONEY_FILE_MAX, MONEY_PART_BYTES } from '@shared/contract-work-money'
import { MoneyError } from './read'

/**
 * A file that comes to the host in parts (docs/agents/work-money.md "Bytes
 * to the host"): each part is written to the file's own folder as it
 * lands, in any order and more than once, and the file is put together
 * when the last one is there. No upload outside a thread exists yet; when
 * Files builds one, Money may switch to it and delete this.
 */

const partName = (n: number): string => `part-${n}`

/** Where a printed page's parts wait: by the job and the sender's key, so a key sent under another job never finishes this one's upload. */
export const pageFolder = (dataDir: string, workspaceId: string, key: string): string => join(dataDir, 'work-money', 'keeping', createHash('sha256').update(`${workspaceId}\n${key}`).digest('hex').slice(0, 32))

/**
 * Takes one part. Answers the whole file's path once every part is in,
 * null while some are missing. Refuses a part past its size, a file past
 * the cap, and a count that changed between parts.
 */
export async function takePart(dir: string, name: string, p: { part: number; parts: number; dataBase64: string }): Promise<string | null> {
  if (p.part >= p.parts) throw new MoneyError('That part is past the end of the file.')
  const bytes = Buffer.from(p.dataBase64, 'base64')
  if (bytes.length > MONEY_PART_BYTES) throw new MoneyError('A part is at most 2 MB.')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const count = join(dir, 'parts')
  if (existsSync(count)) {
    if (Number(readFileSync(count, 'utf8')) !== p.parts) throw new MoneyError('The number of parts changed: send the file again.')
  } else writeFileSync(count, String(p.parts))
  writeFileSync(join(dir, partName(p.part)), bytes)
  const have = readdirSync(dir).filter((f) => f.startsWith('part-'))
  const size = have.reduce((n, f) => n + statSync(join(dir, f)).size, 0)
  if (size > MONEY_FILE_MAX) {
    rmSync(dir, { recursive: true, force: true })
    throw new MoneyError('That file is over 25 MB.')
  }
  if (have.length < p.parts) return null
  const whole = join(dir, name)
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(whole, { mode: 0o600 })
    out.on('error', reject)
    out.on('finish', resolve)
    for (let n = 0; n < p.parts; n++) out.write(readFileSync(join(dir, partName(n))))
    out.end()
  })
  for (const f of have) rmSync(join(dir, f), { force: true })
  rmSync(count, { force: true })
  return whole
}

/** A file's bytes as the wire carries them: one part of at most 2 MB, and how many there are. */
export function partOf(path: string, part: number): { size: number; parts: number; dataBase64: string } {
  const size = statSync(path).size
  const parts = Math.max(1, Math.ceil(size / MONEY_PART_BYTES))
  if (part >= parts) throw new MoneyError('That part is past the end of the file.')
  const bytes = readFileSync(path).subarray(part * MONEY_PART_BYTES, (part + 1) * MONEY_PART_BYTES)
  return { size, parts, dataBase64: bytes.toString('base64') }
}
