import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PUBLIC_HOSTS } from '../../src/shared/publicHosts'

/** The tunnel's rules in order, read line by line: each `- ` opens a rule, its keys follow. */
function rules(): Record<string, string>[] {
  const out: Record<string, string>[] = []
  for (const line of readFileSync(join(__dirname, 'ingress.yml'), 'utf8').split('\n')) {
    const m = /^\s*(- )?(hostname|path|service): (.+)$/.exec(line)
    if (!m) continue
    if (m[1]) out.push({})
    out[out.length - 1]![m[2]!] = m[3]!.trim()
  }
  return out
}

describe('scripts/box/ingress.yml', () => {
  it('gives each public name the same rules, the Work service before the remote listener', () => {
    const of = (host: string): Omit<Record<string, string>, 'hostname'>[] =>
      rules().filter((r) => r.hostname === host).map(({ hostname: _, ...rest }) => rest)
    const expected = [
      { path: '^/(g|w|f)/', service: 'http://127.0.0.1:7695' },
      { service: 'http://127.0.0.1:7677' }
    ]
    for (const host of PUBLIC_HOSTS) expect(of(host)).toEqual(expected)
  })

  it('keeps the guest origin on the Work port alone, before the public names, and ends in a 404', () => {
    const all = rules()
    expect(all.filter((r) => r.hostname === 'share.landonhale.com')).toEqual([{ hostname: 'share.landonhale.com', service: 'http://127.0.0.1:7695' }])
    const first = all.findIndex((r) => (PUBLIC_HOSTS as readonly string[]).includes(r.hostname ?? ''))
    expect(all.findIndex((r) => r.hostname === 'share.landonhale.com')).toBeLessThan(first)
    expect(all.at(-1)).toEqual({ service: 'http_status:404' })
  })
})
