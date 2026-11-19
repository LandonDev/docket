import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { check, failed, note, pair, Proof, REPO, rpc, textOf, until, type Inst } from './harness'

/**
 * Milestone 7's first step (architecture §19, [TEST M7]): a thread on a
 * second host makes its add-on call with that host's own key, read from
 * that host's own vault. Two isolated instances, "mac" (darwin by the seam)
 * paired to "box" (linux, the settings home), Work on both; two fake http
 * MCP servers that each admit one Authorization value and answer `whoami`
 * with its sha256 prefix.
 *
 *  A. A Work workspace only the mac has: its add-on row and grant are
 *     written on the mac; a mac Work thread's call carries the mac's value;
 *     the box holds neither the row nor the grant.
 *  B. A Work workspace of one name on both hosts (linked by folder name):
 *     where its row and grant live, and what a mac Work thread's call
 *     carries. Recorded, since it decides who mints a linked workspace's key.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE bun src/main/server/work/lifeos/proof/firstStep.ts
 */

const BUN = process.execPath
const FAKE = join(REPO, 'scripts', 'lib', 'fakeMcpServer.ts')
const prefix = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12)
const proof = new Proof()

async function fakeServer(value: string): Promise<number> {
  const proc = proof.own(spawn(BUN, [FAKE, '--http', '0', '--require', `Authorization=${value}`], { stdio: ['ignore', 'pipe', 'inherit'], detached: true }))
  return new Promise<number>((ok) => proc.stdout!.once('data', (d: Buffer) => ok((JSON.parse(d.toString()) as { http: number }).http)))
}

/** Whether any file under the instance's Aliax dir holds `needle` in the clear. */
function vaultMentions(inst: Inst, needle: string): boolean {
  const walk = (dir: string): boolean =>
    existsSync(dir) &&
    readdirSync(dir).some((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : readFileSync(p).includes(needle)
    })
  return walk(join(inst.data, 'aliax'))
}

interface AddonsList {
  addons: { id: string; name: string; workspaceId: string | null }[]
  status: Record<string, { state: string; detail?: string }>
  home: { name: string } | null
}
const statusOf = async (inst: Inst, id: string): Promise<string | undefined> => (await rpc<AddonsList>(inst, 'addons.list', {})).status[id]?.state
const spec = (port: number) => ({ transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: ['Authorization'], auth: 'fields' })

try {
  const macValue = `Bearer m7-mac-${randomBytes(6).toString('hex')}`
  const boxValue = `Bearer m7-box-${randomBytes(6).toString('hex')}`
  const [macPort, boxPort] = await Promise.all([fakeServer(macValue), fakeServer(boxValue)])

  const mac = await proof.instance('mac')
  const box = await proof.instance('box')
  proof.launch(mac, { platform: 'darwin' })
  proof.launch(box, { platform: 'linux' })
  if (!check('both instances up', (await proof.up(mac)) && (await proof.up(box)))) throw new Error(`logs: ${mac.log} ${box.log}`)
  for (const inst of [mac, box]) await rpc(inst, 'work.set', { enabled: true })
  await pair(proof, mac, box, 'box')

  // ── A. a workspace only the mac has ──────────────────────────────────
  const macOnly = await rpc<{ id: string; linkId?: string | null }>(mac, 'workspace.create', { kind: 'work', sector: 'life', name: 'Only on the mac' })
  // Give the linker a run (link-up, the catalog change) before reading where the scope lives.
  await until('the linker ran', 15_000, () => proof.logOf(mac).includes('[project-links]') || false)
  const homeA = (await rpc<AddonsList>(mac, 'addons.list', { workspaceId: macOnly.id })).home
  check("A: the mac-only workspace's add-ons are the mac's own (no home elsewhere)", homeA === null, JSON.stringify(homeA))
  const rowA = (await rpc<{ addon: { id: string } }>(mac, 'addons.set', { addon: { name: 'lifeos', workspaceId: macOnly.id, spec: spec(macPort) } })).addon
  await rpc(mac, 'addons.grant.setFields', { id: rowA.id, fields: { Authorization: macValue } })
  check('A: the row is ready on the mac with the value in its own vault', await until('ready on mac', 30_000, async () => (await statusOf(mac, rowA.id)) === 'ready'))
  const threadA = await rpc<{ id: string; scope?: string }>(mac, 'session.create', { provider: 'claude', workspaceId: macOnly.id, threadType: 'chat', permission: 'auto', title: 'm7 first step A' })
  check('A: the mac thread is a Work thread', threadA.scope === 'work', JSON.stringify(threadA))
  const whoA = await rpc<{ content: { type: string; text?: string }[] }>(mac, 'app.addonCall', { sessionId: threadA.id, tool: 'lifeos__whoami' })
  check("A: the mac thread's add-on call carried the mac's own value", textOf(whoA) === prefix(macValue), textOf(whoA))
  await until('a sync pass', 10_000, () => false)
  const boxRows = (await rpc<AddonsList>(box, 'addons.list', {})).addons
  check('A: the box holds no row of it', !boxRows.some((r) => r.id === rowA.id), JSON.stringify(boxRows))
  check("A: the box's vault holds no grant of it, nor the value", !vaultMentions(box, rowA.id) && !vaultMentions(box, macValue))
  check("A: the mac's vault holds its grant (by id, the value sealed)", vaultMentions(mac, rowA.id) && !vaultMentions(mac, macValue))

  // ── B. one workspace name on both hosts ───────────────────────────────
  const macShared = await rpc<{ id: string }>(mac, 'workspace.create', { kind: 'work', sector: 'purdue', name: 'Both' })
  const boxShared = await rpc<{ id: string }>(box, 'workspace.create', { kind: 'work', sector: 'purdue', name: 'Both' })
  const linked = await until('linked', 60_000, async () => {
    const [m, b] = await Promise.all([rpc<{ id: string; linkId?: string | null }[]>(mac, 'workspace.list'), rpc<{ id: string; linkId?: string | null }[]>(box, 'workspace.list')])
    const mw = m.find((w) => w.id === macShared.id)
    return !!mw?.linkId && mw.linkId === b.find((w) => w.id === boxShared.id)?.linkId
  })
  note(`B: the two Work workspaces named "Both" ${linked ? 'were linked by folder name' : 'were NOT linked'}`)
  const homeB = linked ? await until('home is the box', 60_000, async () => (await rpc<AddonsList>(mac, 'addons.list', { workspaceId: macShared.id })).home?.name === 'box') : false
  note(`B: the mac ${homeB ? 'routes' : 'does not route'} that workspace's add-ons to the box`)
  if (linked && homeB) {
    const rowB = (await rpc<{ addon: { id: string } }>(box, 'addons.set', { addon: { name: 'lifeos', workspaceId: boxShared.id, spec: spec(boxPort) } })).addon
    await rpc(box, 'addons.grant.setFields', { id: rowB.id, fields: { Authorization: boxValue } })
    const follows = await until('mac follows the row', 30_000, async () => (await rpc<AddonsList>(mac, 'addons.list', {})).addons.some((r) => r.id === rowB.id))
    note(`B: the mac ${follows ? 'follows' : 'does not follow'} the box's row`)
    const macState = await until('ready on mac', 30_000, async () => (await statusOf(mac, rowB.id)) === 'ready')
    note(`B: on the mac the row is ${await statusOf(mac, rowB.id)}${macState ? ' (the grant reached the mac)' : ''}`)
    note(`B: the mac's vault ${vaultMentions(mac, rowB.id) ? 'holds' : 'does not hold'} a copy of the box's grant`)
    const threadB = await rpc<{ id: string }>(mac, 'session.create', { provider: 'claude', workspaceId: macShared.id, threadType: 'chat', permission: 'auto', title: 'm7 first step B' })
    try {
      const whoB = await rpc<{ content: { type: string; text?: string }[] }>(mac, 'app.addonCall', { sessionId: threadB.id, tool: 'lifeos__whoami' })
      note(`B: the mac thread's call carried ${textOf(whoB) === prefix(boxValue) ? "the box's value, from the mac's vault copy" : textOf(whoB)}`)
    } catch (err) {
      note(`B: the mac thread's call failed: ${(err as Error).message}`)
    }
  }
} catch (err) {
  check('the proof ran to the end', false, (err as Error).stack ?? String(err))
} finally {
  await proof.close()
}
console.log(failed() ? `${failed()} FAILED` : 'ALL PASS')
process.exit(failed() ? 1 : 0)
