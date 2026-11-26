/**
 * Seeds the isolated `box` of a perf run before it starts, for the code family (scripts/perf/run.ts `--family code`):
 * a plain workspace on a scratch git repo of 20,000 tracked files (the pickers' list), and stand-in threads made
 * from a seed (scripts/lib/ios-perf-seeds.ts `perfThread`), so every run opens the same threads: one agent-shaped
 * thread of 30,000 rows in 2 turns, a 2,000-row chat, six short ones to switch among, and a pinned master with a
 * batch of 30 children of 100 to 300 rows each (the board's). Nothing here is his: the
 * rows are generated, the repo is made in the run's own folder.
 *
 * It writes through the server's own registry, as scripts/measure-transcript-seed.ts does, so it is bundled with
 * the electron shim and run under node by the kit, on a data folder no instance is running on yet:
 *
 *   bun scripts/bundle-server.ts scripts/perf/seed-box.ts
 *   PERF_SEED_DATA=<userData> PERF_SEED_REPO=<folder> node scripts/.out/seed-box.mjs
 *
 * It prints one JSON line: the workspace, the project and the threads it made.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { startServer } from '../../src/main/server/index'
import { perfThread } from '../lib/ios-perf-seeds'
import { SEED_CHILDREN, SEED_FILES, SEED_MASTER, SEED_SHORT, SEED_THREADS, SEED_WORKSPACE } from './lib/seedNames'

const data = process.env.PERF_SEED_DATA
const repo = process.env.PERF_SEED_REPO
const files = Number(process.env.PERF_SEED_FILES ?? SEED_FILES)
if (!data || !repo) {
  console.error('PERF_SEED_DATA and PERF_SEED_REPO name the data folder and the scratch repo')
  process.exit(2)
}
// The old name: the instance's own first boot moves it to docket.db (src/main/dataMove.ts).
if (existsSync(join(data, 'temp-code.db')) || existsSync(join(data, 'docket.db'))) {
  console.error(`${data} already holds a database: the seed is for a fresh folder`)
  process.exit(2)
}

mkdirSync(repo, { recursive: true })
for (let i = 0; i < files; i++) {
  const dir = join(repo, 'src', `area${i % 40}`, `part${Math.floor(i / 40) % 25}`)
  if (i < 1000) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `file${i}.ts`), `export const n${i} = ${i}\n`)
}
writeFileSync(join(repo, 'README.md'), '# Perf code\n\nA scratch project of a perf run.\n')
const git = (...args: string[]): void => void execFileSync('git', ['-c', 'user.name=Perf', '-c', 'user.email=perf@example.test', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { stdio: 'ignore' })
git('init', '-q', '-b', 'main')
git('add', '-A')
git('commit', '-q', '-m', 'A scratch project')

const aliax = mkdtempSync(join(tmpdir(), 'perf-seed-aliax-'))
configure({
  dataDir: aliax,
  fetch: async (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-perf-seed'
})
const server = await startServer(join(data, 'temp-code.db'), { claimShim: false, remotePort: 0 })
const workspace = await server.registry.createWorkspace(repo, SEED_WORKSPACE)
const project = await server.registry.createProject(workspace.id, 'perf', 'local')
const threads: { id: string; title: string; rows: number }[] = []
// The master first: its children carry its id (`masterId`), which is all a batch is (docs/agents/master-threads.md).
const seeds = [SEED_THREADS.long, SEED_THREADS.chat, ...SEED_SHORT, SEED_MASTER, ...SEED_CHILDREN]
for (const thread of seeds) {
  await server.registry.create({
    id: thread.id, provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'implementer', permission: 'edits',
    projectId: project.id, threadType: thread.type, title: thread.title,
    ...(thread.id === SEED_MASTER.id ? { master: true } : thread.id.startsWith('perf-child-') ? { masterId: SEED_MASTER.id } : {})
    // No harness: the seed writes rows and closes; a boot here would spawn a CLI for every thread.
  }, { eager: false })
  const events = perfThread(thread.id, thread)
  for (let i = 0; i < events.length; i++) {
    server.registry.append(thread.id, events[i]!)
    // Let the flush write what was appended: 30,000 rows in one tick would be one transaction of them all.
    if (i % 2000 === 1999) await new Promise((resolve) => setImmediate(resolve))
  }
  threads.push({ id: thread.id, title: thread.title, rows: events.length })
}
await server.close()
rmSync(aliax, { recursive: true, force: true })
console.log(JSON.stringify({ workspaceId: workspace.id, projectId: project.id, path: repo, threads }))
process.exit(0)
