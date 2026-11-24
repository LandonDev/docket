import { z, type ZodType } from 'zod'

/**
 * What an agent reads when a Work tool's input does not fit (work/ctx.ts `tools.call`): the field, what it
 * must be, the field's own help and one value that would pass, all from the tool's schema. Never zod's
 * issue dump: an agent fixes one field from plain words faster than from JSON.
 */

type Json = Record<string, unknown>
type Issue = z.core.$ZodIssue

const MAX_LINES = 3
const quote = (value: unknown): string => JSON.stringify(value)

/** `cells[0].at`, as an agent writes it back. */
export const fieldOf = (path: readonly PropertyKey[]): string =>
  path.reduce<string>((out, seg) => (typeof seg === 'number' ? `${out}[${seg}]` : out ? `${out}.${String(seg)}` : String(seg)), '')

/** The JSON schema node at `path`, through `$ref`s, unions and lists; null where it cannot be found. */
function nodeAt(root: Json, path: readonly PropertyKey[]): Json | null {
  const deref = (node: Json): Json => {
    const ref = node.$ref
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return node
    const found = ref.slice(2).split('/').reduce<unknown>((at, key) => (at as Json | undefined)?.[key], root)
    return found && typeof found === 'object' ? (found as Json) : node
  }
  let node: Json | null = deref(root)
  for (const seg of path) {
    if (!node) return null
    const branches = [...((node.anyOf ?? node.oneOf ?? []) as Json[]), node].map(deref)
    let next: Json | null = null
    for (const branch of branches) {
      const child = typeof seg === 'number' ? branch.items : (branch.properties as Json | undefined)?.[String(seg)]
      if (child && typeof child === 'object') {
        next = deref(child as Json)
        break
      }
    }
    node = next
  }
  return node
}

const DATE_EXAMPLES: Record<string, string> = {
  'date-time': '2026-11-24T15:00:00Z',
  date: '2026-11-24',
  time: '09:00:00',
  email: 'name@example.com',
  uri: 'https://example.com'
}

/** One value the node accepts, or undefined where only words would do (a plain string). */
function exampleOf(node: Json | null, depth = 0): unknown {
  if (!node || depth > 3) return undefined
  if (Array.isArray(node.examples) && node.examples.length > 0) return node.examples[0]
  if (node.default !== undefined) return node.default
  if (node.const !== undefined) return node.const
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0]
  if (node.type === 'boolean') return true
  if (node.type === 'integer' || node.type === 'number') {
    // zod draws an int's safe range as its bounds: those say nothing an example should follow.
    const bound = (n: unknown): n is number => typeof n === 'number' && Math.abs(n) < Number.MAX_SAFE_INTEGER
    const min = bound(node.minimum) ? node.minimum : bound(node.exclusiveMinimum) ? Math.floor(node.exclusiveMinimum) + 1 : 1
    return bound(node.maximum) ? Math.min(min, node.maximum) : min
  }
  if (node.type === 'string' && typeof node.format === 'string') return DATE_EXAMPLES[node.format]
  if (node.type === 'array') {
    const item = exampleOf(node.items as Json | null, depth + 1)
    return item === undefined ? undefined : [item]
  }
  return undefined
}

const TYPE_WORDS: Record<string, string> = {
  string: 'text',
  number: 'a number',
  int: 'a whole number',
  boolean: 'true or false',
  array: 'a list',
  object: 'an object',
  null: 'null'
}
const typeWords = (expected: string): string => TYPE_WORDS[expected] ?? expected
const ofWhat = (origin: string): string => (origin === 'string' ? ' characters' : origin === 'array' || origin === 'set' ? ' items' : '')
const FORMAT_WORDS: Record<string, string> = {
  datetime: 'an ISO 8601 date and time',
  date: 'a date as YYYY-MM-DD',
  time: 'a time as HH:MM',
  email: 'an email address',
  url: 'a URL',
  uuid: 'a UUID'
}

/** What is wrong with one field, in words; the value read from `args` tells a missing field from a wrong one. */
function problemOf(issue: Issue, given: unknown): string {
  switch (issue.code) {
    case 'invalid_type':
      return given === undefined ? 'is missing' : `must be ${typeWords(issue.expected)}`
    case 'too_big':
      return `must be at most ${String(issue.maximum)}${ofWhat(issue.origin)}`
    case 'too_small':
      return `must be at least ${String(issue.minimum)}${ofWhat(issue.origin)}`
    case 'invalid_value':
      return `must be one of ${issue.values.map(quote).join(', ')}`
    case 'invalid_format':
      return `must be ${FORMAT_WORDS[issue.format] ?? `in the ${issue.format} form`}`
    case 'invalid_union': {
      const options = (issue as { options?: unknown[] }).options
      return options?.length ? `must be one of ${options.map(quote).join(', ')}` : 'does not match any form this field takes'
    }
    case 'not_multiple_of':
      return `must be a multiple of ${String(issue.divisor)}`
    default:
      return issue.message
  }
}

const valueAt = (args: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>((at, seg) => (at && typeof at === 'object' ? (at as Record<PropertyKey, unknown>)[seg] : undefined), args)

/** One sentence (two with an example) for one issue. */
function lineOf(issue: Issue, root: Json, args: unknown): string {
  if (issue.code === 'unrecognized_keys') {
    const node = nodeAt(root, issue.path)
    const fields = Object.keys((node?.properties as Json | undefined) ?? {})
    const where = issue.path.length ? ` in ${fieldOf(issue.path)}` : ''
    const which = issue.keys.map((k) => fieldOf([...issue.path, k])).join(', ')
    return `${which} ${issue.keys.length === 1 ? 'is not a field' : 'are not fields'}${where}${fields.length ? `; the fields are ${fields.join(', ')}` : ''}.`
  }
  const field = fieldOf(issue.path) || 'the input'
  const node = nodeAt(root, issue.path)
  const help = typeof node?.description === 'string' && node.description.trim() ? ` (${node.description.trim().replace(/\.$/, '')})` : ''
  const example = exampleOf(node)
  return `${field} ${problemOf(issue, valueAt(args, issue.path))}${help}.${example === undefined ? '' : ` For example: ${field}: ${quote(example)}.`}`
}

/** The answer to an input that does not fit `input`: what was wrong, field by field, and what to do. */
export function inputProblemWords(tool: string, input: ZodType, args: unknown, issues: readonly Issue[]): string {
  let root: Json = {}
  try {
    root = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as Json
  } catch {
    // A schema that cannot be drawn still has its issues; the words go without help or examples.
  }
  const lines = issues.slice(0, MAX_LINES).map((issue) => lineOf(issue, root, args))
  const more = issues.length > MAX_LINES ? ` ${issues.length - MAX_LINES} more field${issues.length - MAX_LINES === 1 ? '' : 's'} did not fit either.` : ''
  return `Nothing ran: the input does not fit ${tool}. ${lines.join(' ')}${more} Fix the input and call ${tool} again.`
}

/** Edit distance, for the near name of a tool an agent mistyped. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}

/** The closest of `names` to `name`, when it is near enough to be a slip (a third of the name's length, at least 2); else null. */
export function nearestName(name: string, names: readonly string[]): string | null {
  let best: string | null = null
  let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1
  for (const candidate of names) {
    const d = distance(name, candidate)
    if (d < bestDistance) [best, bestDistance] = [candidate, d]
  }
  return best
}

/** The answer to a call of a tool this thread does not have. `names` are the thread's own tools, so the hint is never one it may not call. */
export function unknownToolWords(name: string, names: readonly string[]): string {
  const near = nearestName(name, names)
  return `Nothing ran: ${name} is not in this thread's tool list. A Work thread's tools depend on its workspace. Read the tool list again and call a tool it names${near ? `; the nearest is ${near}` : ''}.`
}

/** The answer to a Work tool call while Work is off on this host. */
export const WORK_OFF_WORDS = 'Nothing ran: Work is off on this host, so this thread has no Work tools now. Tell the owner; he can turn Work on in Settings → Work.'
