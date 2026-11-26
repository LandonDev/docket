// bun scripts/ui-preview-pair.ts --out /tmp/pair --shot
// Captures the real pairing page against fake replies and a key that only exists here.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { JSDOM } from 'jsdom'
import { SESSION_NEEDS_CLIENT } from '../src/main/server/remote/auth'
import { pairPageHtml, pairPageScript } from '../src/main/server/remote/pairPage'

type Answer = { status: number; body?: object; retry?: string }
const states: Record<string, Answer[] | null> = {
  Blank: null,
  Linked: [],
  Refused: [{ status: 401 }],
  RateLimited: [{ status: 429, retry: '120' }],
  KeyShownOnce: [{ status: 400, body: { error: SESSION_NEEDS_CLIENT } }, { status: 200, body: { name: 'Field laptop', key: 'preview-only-key-never-valid' } }]
}

export async function pairPreview(state: string, light: boolean): Promise<string> {
  const answers = states[state] === null ? null : [...states[state]]
  const url = 'https://pair.example/pair' + (answers ? '#GUIDE-MAP01' : '')
  const original = pairPageHtml('preview').replace(/<script[\s\S]*<\/script>/, '')
  const dom = new JSDOM(original, { url, runScripts: 'outside-only' })
  try {
    const { window } = dom
    const respond = async () => {
      const answer = answers?.shift()
      if (!answer) throw new Error('No fixture reply')
      return { ok: answer.status < 300, status: answer.status, json: async () => answer.body ?? {}, headers: { get: () => answer.retry ?? null } }
    }
    new window.Function('fetch', pairPageScript())(respond)
    if (answers?.length) {
      window.document.querySelector<HTMLButtonElement>('#go')?.click()
      // The page reads the response and may then issue a second request.
      await new Promise<void>((done) => setTimeout(done, 0))
    }
    return dom.serialize().replace(
      /@media \(prefers-color-scheme: light\) \{ (:root \{ [^}]+\}) \}/,
      light ? '$1' : '',
    )
  } finally {
    dom.window.close()
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string', default: '/tmp/ui-preview-pair' }, shot: { type: 'boolean' } } })
  const out = resolve(values.out)
  await mkdir(out, { recursive: true })
  const { chromePath, screenshots } = await import('./ui-preview')
  const chrome = values.shot ? chromePath() : null
  if (values.shot && !chrome) throw new Error('--shot needs headless Chrome')
  for (const name of Object.keys(states)) {
    for (const light of [false, true]) {
      const html = await pairPreview(name, light)
      const stem = join(out, name + (light ? '.light' : ''))
      await writeFile(stem + '.html', html)
      if (chrome) await screenshots(chrome, html, stem, [864, 400])
      console.log(stem + '.html')
    }
  }
}

if (import.meta.main) await main()
