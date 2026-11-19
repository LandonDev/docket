import { randomBytes } from 'node:crypto'

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Fills every {{NAME}} in the answer file, XML-escaped; a field with no value, or a value with no field, is an error. */
export function renderAnswerFile(template: string, values: Record<string, string>): string {
  const used = new Set<string>()
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name: string) => {
    if (!(name in values)) throw new Error(`answer file field {{${name}}} has no value`)
    used.add(name)
    return xmlEscape(values[name])
  })
  const unused = Object.keys(values).filter((k) => !used.has(k))
  if (unused.length) throw new Error(`answer file has no field for ${unused.join(', ')}`)
  return out
}

/** A local password: 24 characters with every class Windows' complexity rule counts, no XML or shell metacharacters. */
export function makePassword(bytes: Buffer = randomBytes(24)): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const body = [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
  return `${body.slice(0, 20)}-Aa9`
}
