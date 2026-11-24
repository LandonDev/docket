/**
 * What a CLAUDE.md section cites: the `script:` entries and `bun run` names
 * (each must be a key of package.json's `scripts`) and the repository paths
 * under src/, scripts/, native/, docs/, ios/ and infra/ (each must exist).
 * scripts/docsGuard.test.ts runs it over the sections the docs sweep wrote,
 * and `wireNames` over the Work docs (docs/agents/work*.md).
 */

/** The text of the `## <heading>` section, up to the next `## `, or null. */
export function sectionOf(markdown: string, heading: string): string | null {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

const ROOTS = ['src', 'scripts', 'native', 'docs', 'ios', 'infra']
const PATH = new RegExp(`(?<![\\w./@~-])((?:${ROOTS.join('|')})/(?:[^\\s\`'"(),;|{]|\\{[^}\\s]*\\})*)`, 'g')
const SCRIPT = /\bscript:([a-z0-9][a-z0-9:-]*[a-z0-9])/g
const BUN_RUN = /\bbun run ([a-z][^\s`'"),;]*)/g

/** `a/{b,c}.ts` as `a/b.ts` and `a/c.ts`, one level. */
export function expandBraces(token: string): string[] {
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(token)
  return m ? m[2].split(',').map((part) => `${m[1]}${part}${m[3]}`) : [token]
}

export interface Citations {
  scripts: string[]
  paths: string[]
}

/** Every script name and path the text cites, each once, in order of first mention. */
export function citations(text: string): Citations {
  const scripts = new Set<string>()
  for (const m of text.matchAll(SCRIPT)) scripts.add(`script:${m[1]}`)
  for (const m of text.matchAll(BUN_RUN)) {
    const name = m[1].replace(/[.:]+$/, '')
    // `bun run scripts/x.ts` runs a file: the path rule checks it.
    if (!name.includes('/') && !/\.(ts|mjs|js|sh)$/.test(name)) scripts.add(name)
  }
  const paths = new Set<string>()
  for (const m of text.matchAll(PATH)) {
    const token = m[1].split('#')[0].replace(/[.:]+$/, '')
    if (token.includes('*') || token.includes('<')) continue
    for (const path of expandBraces(token)) paths.add(path.replace(/[.:]+$/, ''))
  }
  return { scripts: [...scripts], paths: [...paths] }
}

const CODE_SPAN = /`([^`\n]+)`/g
const WIRE = /(?<![\w.$/])work(?:\.[A-Za-z]\w*)+(?:\.\{[^}]*\})?(?=([^\w.]|$))/g

/**
 * The `work.<pillar>.<method>` names a doc writes inside backticks, each once, braces expanded
 * (`work.docs.{open, close}` is two names). Two parts (`work.files`, a push or the router) are left out, and so are a
 * name called as code (`work.tools.of(session)`), a file (`work.test.ts`), a glob (`work.office.files*`) and a placeholder
 * (`work.<pillar>.<verb>`). scripts/docsGuard.test.ts holds the Work docs' names to the contract.
 */
export function wireNames(text: string): string[] {
  const out = new Set<string>()
  for (const span of text.matchAll(CODE_SPAN)) {
    for (const m of span[1].matchAll(WIRE)) {
      const after = span[1][m.index + m[0].length]
      if (after === '(' || after === '*' || after === '<' || /\.(ts|tsx|js|mjs|md|json|swift)$/.test(m[0])) continue
      for (const name of expandBraces(m[0].replace(/\s+/g, ''))) if (name.split('.').length >= 3) out.add(name)
    }
  }
  return [...out]
}
