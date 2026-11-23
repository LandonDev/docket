import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configure } from 'aliax-core'
import { WebSocket } from 'ws'
import type { Capability } from '@shared/capabilities'
import type { RunningServer } from '../../index'
import { LIBREOFFICE_CONVERTERS } from '.'
import { convertersOf, JobRunner, type LinkedHost, type ToolsReport } from './jobs'
import { statePath, type ToolchainState } from './tools'

/**
 * A job asked of a host without LibreOffice runs on a linked host that has
 * it, through a real server: host B is `startServer` with Work on; host A
 * is a job runner with no tools whose link is a key's WebSocket to B's
 * fixed port, as a Mac's or a Windows host's link to the box is.
 *
 * B's LibreOffice is a stand-in script that writes what soffice would
 * (upper-cased), so this runs anywhere. With TEMP_CODE_WORK_TOOLS_DATA set
 * to a userData the installer filled (the box's), B uses that real
 * LibreOffice instead, and the job is a real .odt to .docx.
 */
const REAL = process.env.TEMP_CODE_WORK_TOOLS_DATA
const FIXTURE = join(import.meta.dirname, '../../../../../scripts/work-tools/fixtures/feature.odt')
let root: string
let server: RunningServer

function toolsFor(dataDir: string): void {
  const tools = join(dataDir, 'work-tools')
  mkdirSync(tools, { recursive: true })
  if (REAL) {
    // the real tools, linked folder by folder: B's jobs stay in its own work-tools/jobs
    const state = JSON.parse(readFileSync(statePath(REAL), 'utf8')) as ToolchainState
    for (const t of Object.values(state.tools)) if (t.ok && t.dir) symlinkSync(join(REAL, 'work-tools', t.name), join(tools, t.name))
    copyFileSync(statePath(REAL), statePath(dataDir))
    return
  }
  const dir = join(tools, 'libreoffice', '26.8.3')
  mkdirSync(dir, { recursive: true })
  const soffice = join(dir, 'soffice')
  writeFileSync(
    soffice,
    `#!/bin/sh
out=""; to=""; last=""
while [ $# -gt 0 ]; do case "$1" in --outdir) out="$2"; shift;; --convert-to) to="$2"; shift;; *) last="$1";; esac; shift; done
base=$(basename "$last"); base="\${base%.*}"
tr a-z A-Z < "$last" > "$out/$base.\${to%%:*}"
`
  )
  chmodSync(soffice, 0o755)
  const state: ToolchainState = {
    platform: 'linux-x64',
    at: 1,
    tools: { libreoffice: { name: 'libreoffice', pillar: 'toolchain', version: '26.8.3', licence: 'MPL-2.0', licenceNote: 'stand-in', ok: true, dir: 'libreoffice/26.8.3', bin: 'soffice', at: 1 } }
  }
  writeFileSync(statePath(dataDir), JSON.stringify(state))
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-work-forward-'))
  configure({
    dataDir: join(root, 'aliax'),
    fetch: async () => {
      throw new Error('no network in tests')
    },
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
    appName: 'temp-code-test'
  })
  mkdirSync(join(root, 'out', 'renderer'), { recursive: true })
  writeFileSync(join(root, 'out', 'renderer', 'index.html'), '<!doctype html><html><body></body></html>')
  const b = join(root, 'b')
  mkdirSync(b)
  toolsFor(b)
  const { startServer } = await import('../../index')
  server = await startServer(join(b, 'app.db'), { claimShim: false, remotePort: 0, appPath: root, dataDir: b })
}, 60_000)
afterAll(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true })
})

/** A key's link to B's fixed port, as `PeerLink.request` speaks it. */
async function linkWith(caps: Capability[]): Promise<LinkedHost & { close(): void }> {
  const { token } = await server.remoteAuth.createKey({ name: `link-${caps.join('-')}`, audience: 'client', caps, createdBy: 'local' })
  const ticket = await new Promise<string>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.remote!.port, path: '/api/ticket', method: 'POST', headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve(JSON.parse(text).ticket))
    })
    req.on('error', reject)
    req.end()
  })
  const ws = new WebSocket(`ws://127.0.0.1:${server.remote!.port}/ws?ticket=${ticket}`)
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  const pending = new Map<string, (frame: { ok: boolean; result?: unknown; error?: string }) => void>()
  ws.on('message', (d) => {
    const frame = JSON.parse(String(d))
    if (!frame.push) pending.get(frame.id)?.(frame)
  })
  let next = 1
  return {
    id: server.environmentId,
    request: <T,>(method: string, params?: unknown) =>
      new Promise<T>((resolve, reject) => {
        const id = String(next++)
        pending.set(id, (f) => (f.ok ? resolve(f.result as T) : reject(new Error(f.error))))
        ws.send(JSON.stringify({ id, method, params }))
      }),
    close: () => ws.close()
  }
}

describe('a job forwarded to a linked host', () => {
  it('B, with Work on, says what it has and what it converts', async () => {
    const admin = await linkWith(['admin'])
    await admin.request('work.set', { enabled: true })
    const report = await admin.request<ToolsReport>('work.formats.tools', {})
    expect(report.host).toBe(server.environmentId)
    expect(report.tools.find((t) => t.name === 'libreoffice')).toMatchObject({ ok: true, version: '26.8.3', licence: 'MPL-2.0' })
    expect(report.converts).toContainEqual({ from: 'odt', to: 'docx' })
    admin.close()
  })

  it('a read-only key may ask what B has, never make it run a job', async () => {
    const reader = await linkWith(['read'])
    await expect(reader.request('work.formats.tools', {})).resolves.toMatchObject({ host: server.environmentId })
    await expect(reader.request('work.formats.convert', { from: 'odt', to: 'docx', name: 'a.odt', data: '' })).rejects.toThrow('forbidden: work.formats.convert needs operate')
    reader.close()
  })

  it("takes a format's +renderer suffix through request validation, and nothing looser", async () => {
    const link = await linkWith(['read', 'operate'])
    const data = Buffer.from('x').toString('base64')
    // Past the schema and into the runner, which has no such pair here: the refusal is the runner's own.
    await expect(link.request('work.formats.convert', { from: 'docx', to: 'pdf+word', name: 'a.docx', data })).rejects.toThrow('no converter from docx to pdf+word')
    await expect(link.request('work.formats.convert', { from: 'xlsx', to: 'xlsx+ops', name: 'a.xlsx', data })).rejects.toThrow(/no converter from xlsx to xlsx\+ops|not installed|cannot convert/)
    // The schema's own refusals never reach it.
    for (const to of ['pdf+', '+word', 'pdf+word+excel', 'pdf+Word', 'pdf word', '../pdf', 'pdf+wordwordwordx']) {
      await expect(link.request('work.formats.convert', { from: 'docx', to, name: 'a.docx', data }), to).rejects.not.toThrow(/no converter/)
    }
    link.close()
  })

  it('runs on B for A, which has no LibreOffice, and the file comes back to A', async () => {
    const link = await linkWith(['read', 'operate'])
    const a = join(root, 'a')
    mkdirSync(a)
    const runner = new JobRunner({ host: 'mac', dataDir: a, converters: convertersOf([{ id: 'formats', ensure() {}, convert: LIBREOFFICE_CONVERTERS }]), links: () => [link], log: () => {} })
    expect(runner.local('odt', 'docx')).toBeNull()
    const input = join(a, 'feature.odt')
    if (REAL) copyFileSync(FIXTURE, input)
    else writeFileSync(input, 'a document from the mac')
    const out = join(a, 'feature.docx')
    const r = await runner.convert({ from: 'odt', to: 'docx', input, output: out })
    expect(r).toEqual({ output: out, ranOn: server.environmentId, warnings: [] })
    if (REAL) {
      expect(readFileSync(out).subarray(0, 2).toString()).toBe('PK')
      expect(execFileSync('unzip', ['-p', out, 'word/document.xml']).toString()).toContain('Quarterly Plan')
    } else expect(readFileSync(out, 'utf8')).toBe('A DOCUMENT FROM THE MAC')
    link.close()
  }, 120_000)
})
