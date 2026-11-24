import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STEPS, TIER_PATHS, LANE_AFTER, formatReport, gateDir, matchPath, parseArgs, readStoredHash, runSteps, selectSteps, shouldSkipTypecheck, storeHash, tiersForPaths, typecheckHash, type Step, macOnlySkips, judgeReport, spawnStep, stepArgs, atPublishSkips, fmtCap, SOAK_CAP_MS, BUILD_WAIT_MS, proofCap, STORE_MEASURED_MS, STORE_CAP_MS, COMPUTER_MEASURED_MS, COMPUTER_CAP_MS, buildBarrier, gate, screenOnlySkips, EVERY_ROW_PATHS, rowTouched, rowBase, rowSkips, readRowsGreen, storeRowsGreen, proofLines, proofsPhaseLine, fmtPhase, SECOND_TRY_PASSED, SECOND_TRY_FAILED, whenAskedSkips, GUARD_TESTS, type Report } from './gate'
import { BENCH_TIMING } from './lib/computerBench'

describe('the step list', () => {
  it('has unique names, a tier and a lane on every step, and the hook-facing steps in the commit tier', () => {
    const names = STEPS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    for (const s of STEPS) {
      expect(['commit', 'publish']).toContain(s.tier)
      expect(s.lane).toBeTruthy()
    }
    const commit = STEPS.filter((s) => s.tier === 'commit').map((s) => s.name)
    expect(commit).toEqual(expect.arrayContaining(['typecheck', 'vitest', 'build', 'bundle-size']))
    // The bundle-size check reads out/, so it follows the build in the build lane.
    const build = STEPS.find((s) => s.name === 'build')!
    const size = STEPS.find((s) => s.name === 'bundle-size')!
    expect(size.lane).toBe(build.lane)
    expect(STEPS.indexOf(size)).toBeGreaterThan(STEPS.indexOf(build))
    const publish = STEPS.filter((s) => s.tier === 'publish').map((s) => s.name)
    expect(publish).toEqual(expect.arrayContaining(['renderer-soak', 'renderer-soak-chat', 'renderer-soak-typing', 'renderer-soak-scroll', 'renderer-soak-reconnect', 'e2e-remote-fence', 'e2e-addons', 'e2e-addon-grants', 'e2e-skills-store', 'e2e-skills-drivers', 'hub', 'ios', 'ios-client', 'computer-swift', 'e2e-tc-computer', 'e2e-computer-bridge', 'e2e-computer-preview', 'computer-bench']))
    // The soaks read out/ too: in the build lane after the build and its size check, so they never race them,
    // one scene after the other, each failing on its CPU bound (no report-only flag).
    const soak = STEPS.find((s) => s.name === 'renderer-soak')!
    const chat = STEPS.find((s) => s.name === 'renderer-soak-chat')!
    const typing = STEPS.find((s) => s.name === 'renderer-soak-typing')!
    expect(soak).toMatchObject({ tier: 'publish', lane: build.lane, mac: true, cmd: 'bun', args: ['scripts/measure-renderer-soak.ts', '--gate'] })
    expect(chat).toMatchObject({ tier: 'publish', lane: build.lane, mac: true, cmd: 'bun', args: ['scripts/measure-renderer-soak.ts', '--gate', '--scene', 'chat'] })
    expect(STEPS.indexOf(soak)).toBeGreaterThan(STEPS.indexOf(size))
    expect(STEPS.indexOf(chat)).toBeGreaterThan(STEPS.indexOf(soak))
    // The typing scene last in the lane, on its own rule (no CPU bound to report).
    expect(typing).toMatchObject({ tier: 'publish', lane: build.lane, mac: true, cmd: 'bun', args: ['scripts/measure-renderer-soak.ts', '--gate', '--scene', 'typing'] })
    expect(STEPS.indexOf(typing)).toBeGreaterThan(STEPS.indexOf(chat))
    // The scroll scene after it, the same lane.
    const scroll = STEPS.find((s) => s.name === 'renderer-soak-scroll')!
    expect(scroll).toMatchObject({ tier: 'publish', lane: build.lane, mac: true, cmd: 'bun', args: ['scripts/measure-renderer-soak.ts', '--gate', '--scene', 'scroll'] })
    expect(STEPS.indexOf(scroll)).toBeGreaterThan(STEPS.indexOf(typing))
    expect(STEPS.filter((s) => s.hashSkip).map((s) => s.name)).toEqual(['typecheck'])
  })

  it('selects by tier, honours --only and --skip, and refuses an unknown name', () => {
    expect(selectSteps({ tiers: new Set(['commit']) }).map((s) => s.name)).toEqual(['typecheck', 'vitest', 'guards', 'build', 'bundle-size'])
    expect(selectSteps({ tiers: new Set(['publish']) }).map((s) => s.name)).toEqual(['renderer-soak', 'renderer-soak-chat', 'renderer-soak-typing', 'renderer-soak-scroll', 'renderer-soak-reconnect', 'e2e-remote-fence', 'e2e-addons', 'e2e-addon-grants', 'e2e-skills-store', 'e2e-skills-drivers', 'hub', 'ios', 'ios-client', 'computer-swift', 'e2e-tc-computer', 'e2e-computer-bridge', 'e2e-computer-preview', 'computer-bench'])
    expect(selectSteps({ tiers: new Set(['commit', 'publish']) }).length).toBe(STEPS.length)
    expect(selectSteps({ tiers: new Set(['commit']), only: ['vitest'] }).map((s) => s.name)).toEqual(['vitest'])
    expect(selectSteps({ tiers: new Set(['commit']), skip: ['vitest'] }).map((s) => s.name)).toEqual(['typecheck', 'guards', 'build', 'bundle-size'])
    expect(() => selectSteps({ tiers: new Set(['commit']), only: ['nope'] })).toThrow(/no gate step named nope/)
  })

  it('parses the CLI', () => {
    expect(parseArgs([])).toMatchObject({ tiers: new Set(['commit']), full: false, verbose: false })
    expect(parseArgs(['--tier', 'all', '--since', 'release-3', '--full', '-v', '--skip', 'vitest,build'])).toMatchObject({
      tiers: new Set(['commit', 'publish']),
      since: 'release-3',
      full: true,
      verbose: true,
      skip: ['vitest', 'build']
    })
    expect(parseArgs(['--tier=publish']).tiers).toEqual(new Set(['publish']))
    expect(() => parseArgs(['--tier', 'weekly'])).toThrow(/--tier must be/)
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/)
  })
})

describe('the Mac-only steps', () => {
  it('skips the renderer soak, hub, ios and ios-client off macOS with a note, and nothing on it', () => {
    expect([...macOnlySkips(STEPS, 'linux').keys()]).toEqual(['renderer-soak', 'renderer-soak-chat', 'renderer-soak-typing', 'renderer-soak-scroll', 'renderer-soak-reconnect', 'hub', 'ios', 'ios-client', 'computer-swift', 'e2e-tc-computer', 'e2e-computer-bridge', 'e2e-computer-preview', 'computer-bench'])
    expect(macOnlySkips(STEPS, 'linux').get('ios')).toBe('needs the Mac; release:publish runs it there')
    expect(macOnlySkips(STEPS, 'darwin').size).toBe(0)
    expect(STEPS.filter((s) => s.mac).every((s) => s.tier === 'publish')).toBe(true)
  })
})

describe('the screen steps', () => {
  const names = ['e2e-tc-computer', 'e2e-computer-bridge', 'e2e-computer-preview', 'computer-bench']
  const note = 'the Mac is locked or asleep; run it by hand when unlocked'

  it('marks only the four publish screen proofs; the Swift tests still run', () => {
    expect(STEPS.filter((s) => s.screen).map((s) => s.name)).toEqual(names)
    expect(STEPS.filter((s) => s.screen).every((s) => s.mac && s.tier === 'publish')).toBe(true)
    expect(STEPS.find((s) => s.name === 'computer-swift')?.screen).toBeUndefined()
  })

  it.each([
    ['locked', () => ({ locked: true, asleep: false })],
    ['asleep', () => ({ locked: false, asleep: true })],
    ['unreadable', () => null],
    ['failed', () => { throw new Error('screen read failed') }]
  ] as const)('reads once and skips screen rows when %s, keeping the other rows', async (_name, read) => {
    const reader = vi.fn(read)
    const skipped = screenOnlySkips(STEPS, reader, 'darwin')
    expect(reader).toHaveBeenCalledTimes(1)
    expect([...skipped]).toEqual(names.map((name) => [name, note]))
    const ran: string[] = []
    const report = await runSteps(STEPS.filter((s) => s.screen || s.name === 'computer-swift'), async (step) => {
      ran.push(step.name)
      return { exitCode: 0, tail: '' }
    }, {}, skipped)
    expect(ran).toEqual(['computer-swift'])
    expect(report.ok).toBe(true)
    for (const name of names) expect(formatReport(report)).toContain(`${name}`)
    expect(formatReport(report)).toMatch(/skipped {2}the Mac is locked or asleep; run it by hand when unlocked/)
  })

  it('runs all screen rows when unlocked', async () => {
    const reader = vi.fn(() => ({ locked: false, asleep: false }))
    const skipped = screenOnlySkips(STEPS, reader, 'darwin')
    expect(reader).toHaveBeenCalledTimes(1)
    expect(skipped.size).toBe(0)
    const ran: string[] = []
    const report = await runSteps(STEPS.filter((s) => s.screen), async (step) => {
      ran.push(step.name)
      return { exitCode: 0, tail: '' }
    }, {}, skipped)
    expect(ran).toEqual(names)
    expect(report.ok).toBe(true)
  })

  it('never checks off macOS, for the commit tier, or without screen rows', () => {
    const reader = vi.fn(() => { throw new Error('must not check') })
    expect(screenOnlySkips(STEPS, reader, 'linux').size).toBe(0)
    expect(screenOnlySkips(selectSteps({ tiers: new Set(['commit']) }), reader, 'darwin').size).toBe(0)
    expect(screenOnlySkips(STEPS.filter((s) => !s.screen), reader, 'darwin').size).toBe(0)
    expect(reader).not.toHaveBeenCalled()
  })

  it('uses the skip map in the gate runner before starting lanes', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tc-gate-screen-'))
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo })
      const reader = vi.fn(() => ({ locked: true, asleep: false }))
      const steps: Step[] = [
        { name: 'screen', tier: 'publish', lane: 'computer', mac: true, screen: true, cmd: process.execPath, args: ['-e', 'process.exit(9)'], why: '' },
        { name: 'compile', tier: 'publish', lane: 'swift', mac: true, cmd: process.execPath, args: ['-e', ''], why: '' }
      ]
      const report = await gate({ repo, tiers: new Set(['publish']), full: false, verbose: false, steps, platform: 'darwin', readScreen: reader })
      expect(reader).toHaveBeenCalledTimes(1)
      expect(report.ok).toBe(true)
      expect(report.results).toEqual([
        expect.objectContaining({ name: 'screen', outcome: 'skipped', note }),
        expect.objectContaining({ name: 'compile', outcome: 'passed' })
      ])
      expect(JSON.parse(readFileSync(join(gateDir(repo), 'last-run.json'), 'utf8')).steps[0]).toMatchObject({ name: 'screen', outcome: 'skipped', note })
    } finally {
      output.mockRestore()
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('the computer bench row and the caps', () => {
  const bench = STEPS.find((s) => s.name === 'computer-bench')!

  it('is a publish step on the Mac in its own lane, with a cap, never pulled into a commit hook', () => {
    expect(bench).toMatchObject({ tier: 'publish', mac: true, lane: 'computer', onlyAtPublish: true, cmd: 'bun', args: ['run', 'script:e2e-computer-bench', '--', '--gate'] })
    // Last in its lane, after the Mac's TC Probe proofs.
    expect(STEPS.filter((s) => s.lane === 'computer').at(-1)).toBe(bench)
    expect(bench.capMs).toBe(15 * 60_000)
    // The script's own deadline leaves it a minute inside the cap to report and clean up.
    expect(BENCH_TIMING.budgetMs).toBeLessThan(bench.capMs!)
  })

  it('gives every soak row its cap', () => {
    const soaks = STEPS.filter((s) => s.name.startsWith('renderer-soak'))
    expect(soaks).toHaveLength(5)
    for (const s of soaks) expect(s.capMs, s.name).toBe(SOAK_CAP_MS)
    expect(SOAK_CAP_MS).toBe(12 * 60_000)
  })

  it('skips an onlyAtPublish step when changed paths alone pulled its tier, and keeps it when the tier was asked for', async () => {
    expect([...atPublishSkips(STEPS, new Set(['publish']))]).toEqual([['computer-bench', 'runs at publish']])
    expect(atPublishSkips(STEPS, new Set()).size).toBe(0)
    const publish = selectSteps({ tiers: new Set(['publish']) })
    const ran: string[] = []
    const report = await runSteps(
      publish.filter((s) => s.name === 'computer-bench' || s.name === 'e2e-remote-fence'),
      async (s) => {
        ran.push(s.name)
        return { exitCode: 0, tail: '' }
      },
      {},
      atPublishSkips(publish, new Set(['publish']))
    )
    expect(ran).toEqual(['e2e-remote-fence'])
    expect(report.ok).toBe(true)
    expect(formatReport(report)).toMatch(/– computer-bench\s+skipped {2}runs at publish/)
  })

  it('says a cap in minutes, seconds or milliseconds', () => {
    expect(fmtCap(15 * 60_000)).toBe('15m')
    expect(fmtCap(90_000)).toBe('90s')
    expect(fmtCap(300)).toBe('300ms')
  })

  it('kills a step past its cap and fails it with the cap’s line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-gate-cap-'))
    try {
      const sleeper: Step = { name: 'sleeper', tier: 'publish', cmd: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], lane: 'x', why: '', capMs: 300 }
      const quick: Step = { name: 'quick', tier: 'publish', cmd: process.execPath, args: ['-e', ''], lane: 'y', why: '', capMs: 60_000 }
      const t0 = Date.now()
      const report = await runSteps([sleeper, quick], spawnStep({ repo: dir, logDir: join(dir, 'logs'), verbose: false }))
      expect(Date.now() - t0).toBeLessThan(5000)
      expect(report.ok).toBe(false)
      const by = Object.fromEntries(report.results.map((r) => [r.name, r]))
      expect(by.sleeper).toMatchObject({ outcome: 'failed', note: 'passed its 300ms cap' })
      expect(by.quick.outcome).toBe('passed')
      expect(formatReport(report)).toMatch(/✗ sleeper .* failed {2}passed its 300ms cap/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the store and computer proofs', () => {
  const STORE = ['e2e-addons', 'e2e-addon-grants', 'e2e-skills-store', 'e2e-skills-drivers']
  const MAC = ['e2e-tc-computer', 'e2e-computer-bridge', 'e2e-computer-preview']
  const at = (name: string): number => STEPS.findIndex((s) => s.name === name)

  it('runs each as a publish row through its script entry with --gate, under a cap', () => {
    for (const name of [...STORE, ...MAC]) {
      const s = STEPS.find((x) => x.name === name)!
      expect(s, name).toMatchObject({ tier: 'publish', cmd: 'bun', args: ['run', `script:${name}`, '--', '--gate'] })
      expect(s.capMs, name).toBeGreaterThan(BUILD_WAIT_MS)
      expect(s.capMs! % 60_000, name).toBe(0)
      expect(s.onlyAtPublish, name).toBeUndefined()
    }
  })

  it('puts the store proofs one after the other in one lane, right after the fence, on both hosts', () => {
    const fence = STEPS.find((s) => s.name === 'e2e-remote-fence')!
    const lane = STEPS.filter((s) => s.lane === fence.lane).map((s) => s.name)
    expect(lane).toEqual(['e2e-remote-fence', ...STORE])
    for (const name of STORE) expect(STEPS[at(name)].mac, name).toBeUndefined()
    expect(STORE.map(at)).toEqual(STORE.map((_, i) => at('e2e-remote-fence') + 1 + i))
  })

  it("puts the Mac's TC Probe proofs before the bench in the computer lane", () => {
    expect(STEPS.filter((s) => s.lane === 'computer').map((s) => s.name)).toEqual([...MAC, 'computer-bench'])
    for (const name of MAC) expect(STEPS[at(name)].mac, name).toBe(true)
  })

  it('caps a proof at the build wait plus three times its measured time, rounded up to the minute', () => {
    expect(proofCap(133_000)).toBe(BUILD_WAIT_MS + 7 * 60_000)
    expect(proofCap(60_000)).toBe(BUILD_WAIT_MS + 3 * 60_000)
    for (const [name, ms] of Object.entries(STORE_MEASURED_MS)) expect(STORE_CAP_MS[name as keyof typeof STORE_CAP_MS]).toBe(proofCap(ms))
    for (const [name, ms] of Object.entries(COMPUTER_MEASURED_MS)) expect(COMPUTER_CAP_MS[name as keyof typeof COMPUTER_CAP_MS]).toBe(proofCap(ms))
  })
})

describe('the build barrier', () => {
  // gate() prints its status and report; the tests read its results instead.
  beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  it('holds only a run that selects the build, after bundle-size when it runs', () => {
    expect(buildBarrier(selectSteps({ tiers: new Set(['publish']) }), '/g')).toBeNull()
    expect(buildBarrier(selectSteps({ tiers: new Set(['commit', 'publish']) }), '/g')).toEqual({ file: '/g/build.done', after: 'bundle-size' })
    expect(buildBarrier(selectSteps({ tiers: new Set(['commit']), skip: ['bundle-size'] }), '/g')).toEqual({ file: '/g/build.done', after: 'build' })
  })

  it("removes last run's build.done, names it to every step and touches it once the size check passes", async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tc-gate-barrier-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo })
      const dir = gateDir(repo)
      mkdirSync(dir, { recursive: true })
      // Last run's file: a proof that read it would start before this run's build.
      writeFileSync(join(dir, 'build.done'), 'stale\n')
      const seen = join(repo, 'seen.txt')
      const node = (body: string): string[] => ['-e', body]
      const steps: Step[] = [
        // The build checks the stale file is gone before it "builds".
        { name: 'build', tier: 'commit', lane: 'build', why: '', cmd: process.execPath, args: node("if (require('fs').existsSync(process.env.TEMP_CODE_SOAK_BUILD_DONE)) process.exit(3); setTimeout(() => {}, 300)") },
        { name: 'bundle-size', tier: 'commit', lane: 'build', why: '', cmd: process.execPath, args: node("if (require('fs').existsSync(process.env.TEMP_CODE_SOAK_BUILD_DONE)) process.exit(4)") },
        // A proof in another lane: it starts at once, waits for the file, and records what it saw.
        {
          name: 'proof',
          tier: 'publish',
          lane: 'e2e',
          why: '',
          cmd: process.execPath,
          args: node(
            `const fs = require('fs'); const f = process.env.TEMP_CODE_SOAK_BUILD_DONE; const t = setInterval(() => { if (fs.existsSync(f)) { clearInterval(t); fs.writeFileSync(${JSON.stringify(seen)}, f) } }, 20)`
          )
        }
      ]
      const report = await gate({ repo, tiers: new Set(['commit', 'publish']), full: false, verbose: false, steps })
      expect(report.results.map((r) => [r.name, r.outcome])).toEqual([
        ['build', 'passed'],
        ['bundle-size', 'passed'],
        ['proof', 'passed']
      ])
      expect(readFileSync(seen, 'utf8')).toBe(join(dir, 'build.done'))
      expect(existsSync(join(dir, 'build.done'))).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('leaves a run without the build on the caller’s variable', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tc-gate-nobarrier-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo })
      const seen = join(repo, 'seen.txt')
      const step: Step = { name: 'proof', tier: 'publish', lane: 'e2e', why: '', cmd: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(seen)}, process.env.TEMP_CODE_SOAK_BUILD_DONE ?? 'unset')`] }
      const before = process.env.TEMP_CODE_SOAK_BUILD_DONE
      process.env.TEMP_CODE_SOAK_BUILD_DONE = '/stage/build.done'
      try {
        await gate({ repo, tiers: new Set(['publish']), full: false, verbose: false, steps: [step] })
      } finally {
        if (before === undefined) delete process.env.TEMP_CODE_SOAK_BUILD_DONE
        else process.env.TEMP_CODE_SOAK_BUILD_DONE = before
      }
      expect(readFileSync(seen, 'utf8')).toBe('/stage/build.done')
      expect(existsSync(join(gateDir(repo), 'build.done'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('tier selection by path', () => {
  it('pulls the publish tier in for the add-on, skills and computer host code and their proofs', () => {
    for (const path of [
      'src/main/server/addons/addonHost.ts',
      'src/main/server/skills/materialize.ts',
      'src/main/server/computer/sessions.ts',
      'src/main/server/addonStore.ts',
      'src/main/server/skillStore.ts',
      'src/main/server/skillFiles.ts',
      'src/main/server/storeRpc.ts',
      'src/main/server/museConfigDirs.ts',
      'src/shared/addons.ts',
      'src/shared/skills.ts',
      'src/shared/addonGrant.ts',
      'src/shared/addonGrantWords.ts',
      'src/main/addonHostProcess.ts',
      'src/main/addonHostSpawn.ts',
      'scripts/app-mcp-bridge.mjs',
      'scripts/e2e-addons.ts',
      'scripts/e2e-addon-grants.ts',
      'scripts/e2e-skills-store.ts',
      'scripts/e2e-skills-drivers.ts',
      'scripts/e2e-computer-bridge.ts',
      'scripts/e2e-computer.ts',
      'scripts/e2e-tc-computer.ts',
      'scripts/lib/gateBuild.ts',
      'scripts/lib/tcComputerBuild.ts',
      'scripts/lib/proofOrder.ts'
    ]) {
      expect(tiersForPaths([path]).get('publish'), path).toEqual([path])
    }
    // The drivers stay out: nearly every commit touches them.
    for (const path of ['src/main/server/drivers/claude.ts', 'src/main/server/drivers/codex.ts']) expect(tiersForPaths([path]).size, path).toBe(0)
  })

  it('matches globs across segments and within one', () => {
    expect(matchPath('ios/**', 'ios/TempCode/Sources/A.swift')).toBe(true)
    expect(matchPath('ios/**', 'ios/Package.swift')).toBe(true)
    expect(matchPath('ios/**', 'bios/x')).toBe(false)
    expect(matchPath('src/shared/contract*.ts', 'src/shared/contract-crosshost.ts')).toBe(true)
    expect(matchPath('src/shared/contract*.ts', 'src/shared/contracts/a.ts')).toBe(false)
    expect(matchPath('**/*.json', 'package.json')).toBe(true)
    expect(matchPath('**/*.json', 'a/b/c.json')).toBe(true)
    expect(matchPath('**/*.json', 'a/b/c.jsonl')).toBe(false)
  })

  it('pulls the publish tier in for the paths it guards and nothing else', () => {
    const guarded = [
      'ios/TempCodeContract/Sources/TempCodeContract/Generated/Wire.swift',
      'scripts/gen-swift-contract.ts',
      'src/shared/wireSchemas.ts',
      'src/main/server/remote/fence.ts',
      'infra/hub/src/index.ts',
      'native/tc-computer/Sources/ComputerProtocol/Generated/Types.swift',
      'src/shared/computer/protocol.ts',
      'scripts/gen-swift-computer.ts'
    ]
    for (const path of guarded) {
      expect(tiersForPaths([path]).get('publish'), path).toEqual([path])
    }
    for (const path of ['src/main/index.ts', 'src/renderer/src/App.tsx', 'docs/box.md', 'package.json', 'scripts/release.ts']) {
      expect(tiersForPaths([path]).size, path).toBe(0)
    }
    const mixed = tiersForPaths(['CLAUDE.md', 'ios/a.swift', 'infra/hub/wrangler.toml'])
    expect(mixed.get('publish')).toEqual(['ios/a.swift', 'infra/hub/wrangler.toml'])
  })

  it('every rule names a tier the steps have', () => {
    const tiers = new Set(STEPS.map((s) => s.tier))
    for (const r of TIER_PATHS) expect(tiers.has(r.tier), r.pattern).toBe(true)
  })
})

describe('the typecheck hash skip', () => {
  it('skips only when not forced and the stored hash equals the tree hash', () => {
    expect(shouldSkipTypecheck({ full: false, hash: 'a', stored: 'a' })).toBe(true)
    expect(shouldSkipTypecheck({ full: true, hash: 'a', stored: 'a' })).toBe(false)
    expect(shouldSkipTypecheck({ full: false, hash: 'a', stored: 'b' })).toBe(false)
    expect(shouldSkipTypecheck({ full: false, hash: 'a', stored: undefined })).toBe(false)
  })

  it('changes with a committed, a modified, an untracked and a deleted .ts or .json file, and not with a .md', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tc-gate-'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'g', GIT_AUTHOR_EMAIL: 'g@x', GIT_COMMITTER_NAME: 'g', GIT_COMMITTER_EMAIL: 'g@x' } })
    try {
      git('init', '-q')
      mkdirSync(join(repo, 'src'))
      writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1\n')
      writeFileSync(join(repo, 'tsconfig.json'), '{}\n')
      writeFileSync(join(repo, 'README.md'), 'hi\n')
      git('add', '.')
      git('commit', '-qm', 'one')
      const clean = typecheckHash(repo)
      expect(typecheckHash(repo)).toBe(clean)

      writeFileSync(join(repo, 'README.md'), 'changed\n')
      expect(typecheckHash(repo)).toBe(clean)

      writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2\n')
      const modified = typecheckHash(repo)
      expect(modified).not.toBe(clean)
      git('add', '.')
      git('commit', '-qm', 'two')
      expect(typecheckHash(repo)).toBe(modified)

      writeFileSync(join(repo, 'src/b.tsx'), 'export const b = 1\n')
      const untracked = typecheckHash(repo)
      expect(untracked).not.toBe(modified)
      rmSync(join(repo, 'src/b.tsx'))
      expect(typecheckHash(repo)).toBe(modified)

      rmSync(join(repo, 'tsconfig.json'))
      expect(typecheckHash(repo)).not.toBe(modified)

      const dir = gateDir(repo)
      expect(dir).toBe(join(repo, '.git', 'temp-code-gate'))
      expect(readStoredHash(dir)).toBeUndefined()
      storeHash(dir, modified)
      expect(readStoredHash(dir)).toBe(modified)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('the parallel runner', () => {
  const step = (name: string, lane: string, tier: 'commit' | 'publish' = 'commit'): Step => ({
    name,
    tier,
    lane,
    cmd: 'true',
    args: [],
    why: name
  })

  it('runs lanes at once and a lane in order', async () => {
    const steps = [step('a1', 'a'), step('a2', 'a'), step('b1', 'b')]
    const started: string[] = []
    const order: string[] = []
    let release!: () => void
    const gateA1 = new Promise<void>((r) => (release = r))
    const report = await runSteps(steps, async (s) => {
      started.push(s.name)
      if (s.name === 'a1') await gateA1
      order.push(s.name)
      // b1 finishing lets a1 go: a1 can only finish after b1 if the lanes ran at once.
      if (s.name === 'b1') release()
      return { exitCode: 0, tail: '' }
    })
    // b1 ran while a1 waited; a2 waited for a1.
    expect(started.slice(0, 2).sort()).toEqual(['a1', 'b1'])
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('a1'))
    expect(order.indexOf('a2')).toBeGreaterThan(order.indexOf('a1'))
    expect(report.ok).toBe(true)
    expect(report.results.map((r) => [r.name, r.outcome])).toEqual([
      ['a1', 'passed'],
      ['a2', 'passed'],
      ['b1', 'passed']
    ])
  })

  it('starts the computer lane only after the build lane, where the soaks run, has finished', async () => {
    expect(LANE_AFTER).toEqual({ computer: 'build' })
    const steps = [step('renderer-soak', 'build'), step('renderer-soak-scroll', 'build'), step('e2e-tc-computer', 'computer'), step('e2e-remote-fence', 'e2e')]
    const log: string[] = []
    const report = await runSteps(steps, async (s) => {
      log.push(`start ${s.name}`)
      await new Promise((r) => setTimeout(r, s.lane === 'build' ? 20 : 5))
      log.push(`end ${s.name}`)
      return { exitCode: 0, tail: '' }
    })
    expect(report.ok).toBe(true)
    // the e2e lane still runs beside the soaks; the computer lane waits for the last soak
    expect(log.indexOf('start e2e-remote-fence')).toBeLessThan(log.indexOf('end renderer-soak'))
    expect(log.indexOf('start e2e-tc-computer')).toBeGreaterThan(log.indexOf('end renderer-soak-scroll'))
    // with no build lane selected the computer lane starts at once
    const alone = await runSteps([step('e2e-tc-computer', 'computer')], async () => ({ exitCode: 0, tail: '' }))
    expect(alone.results[0].outcome).toBe('passed')
  })

  it('does not start the computer lane after a soak failed', async () => {
    const report = await runSteps([step('renderer-soak', 'build'), step('e2e-tc-computer', 'computer')], async (s) => ({ exitCode: s.lane === 'build' ? 1 : 0, tail: 'boom' }))
    expect(report.results.map((r) => [r.name, r.outcome])).toEqual([['renderer-soak', 'failed'], ['e2e-tc-computer', 'not run']])
  })

  it('names a passed step’s flakes from its output, in the result and the report', async () => {
    const tail = ['✓ fallbacks 7 2380ms', 'flake: fallbacks leg, fallbacks 7: a scroll moves the bar: the bar moved', 'report: /tmp/tc-computer-proof/report.json'].join('\n')
    const report = await runSteps([step('e2e-tc-computer', 'computer'), step('plain', 'b')], async (s) => ({ exitCode: 0, tail: s.name === 'plain' ? '✓ all' : tail }))
    expect(report.ok).toBe(true)
    expect(report.results[0]).toMatchObject({ outcome: 'passed', flakes: ['fallbacks leg, fallbacks 7: a scroll moves the bar: the bar moved'], note: '1 flake' })
    expect(report.results[1].flakes).toBeUndefined()
    expect(formatReport(report)).toContain('      flake: fallbacks leg, fallbacks 7: a scroll moves the bar: the bar moved')
  })

  it('reports the failed step with its exit code and tail, stops the running ones and never starts the rest', async () => {
    const steps = [step('tsc', 'tsc'), step('vitest', 'vitest'), step('build', 'build'), step('size', 'build')]
    const finished: string[] = []
    const report = await runSteps(
      steps,
      (s, signal) =>
        new Promise((resolve) => {
          if (s.name === 'vitest') {
            setTimeout(() => resolve({ exitCode: 1, tail: 'FAIL src/x.test.ts > boom' }), 10)
            return
          }
          if (s.name === 'tsc') {
            resolve({ exitCode: 0, tail: '' })
            return
          }
          // build runs until aborted, like a real child killed with SIGTERM.
          signal.addEventListener('abort', () => resolve({ exitCode: null, tail: 'killed' }), { once: true })
        }),
      { onFinish: (r) => finished.push(`${r.name}:${r.outcome}`) }
    )
    expect(report.ok).toBe(false)
    const by = Object.fromEntries(report.results.map((r) => [r.name, r]))
    expect(by.tsc.outcome).toBe('passed')
    expect(by.vitest).toMatchObject({ outcome: 'failed', exitCode: 1, tail: 'FAIL src/x.test.ts > boom' })
    expect(by.build.outcome).toBe('stopped')
    expect(by.size.outcome).toBe('not run')
    expect(finished).toContain('vitest:failed')
    const text = formatReport(report)
    expect(text).toContain('✗ vitest')
    expect(text).toContain('exit 1')
    expect(text).toContain('FAIL src/x.test.ts > boom')
    expect(text).toContain('■ build')
    expect(text).toContain('· size')
    expect(text).toMatch(/gate failed: vitest/)
  })

  it('treats a thrown spawn error as a failure of that step', async () => {
    const report = await runSteps([step('x', 'x')], async () => {
      throw new Error('spawn ENOENT')
    })
    expect(report.results[0]).toMatchObject({ outcome: 'failed', exitCode: null, tail: 'spawn ENOENT' })
  })

  it('reports a skipped step without running it and keeps the gate green', async () => {
    const ran: string[] = []
    const report = await runSteps(
      [step('typecheck', 'tsc'), step('vitest', 'vitest')],
      async (s) => {
        ran.push(s.name)
        return { exitCode: 0, tail: '' }
      },
      {},
      new Map([['typecheck', 'no change']])
    )
    expect(ran).toEqual(['vitest'])
    expect(report.ok).toBe(true)
    expect(report.results[0]).toMatchObject({ name: 'typecheck', outcome: 'skipped', note: 'no change' })
    expect(formatReport(report)).toContain('– typecheck')
  })
})

describe('the vitest step and its JSON report', () => {
  const report = (over: Record<string, unknown>) => ({ numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, testResults: [], ...over })

  it('the vitest step writes the JSON report beside its log, after the default reporter', () => {
    const vitest = STEPS.find((s) => s.name === 'vitest')!
    expect(vitest.json).toBe(true)
    expect(stepArgs(vitest, '/g/logs')).toEqual({
      args: ['vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile=/g/logs/vitest.json'],
      jsonFile: '/g/logs/vitest.json'
    })
    expect(stepArgs(STEPS.find((s) => s.name === 'typecheck')!, '/g/logs')).toEqual({ args: ['run', 'typecheck'], jsonFile: null })
  })

  it('a green exit is itself, report or not', () => {
    expect(judgeReport(0, 'ok', null)).toEqual({ exitCode: 0, tail: 'ok' })
    expect(judgeReport(0, 'ok', report({ success: false }))).toEqual({ exitCode: 0, tail: 'ok' })
  })

  it('a reporter that died after a green run passes the step on the report, and the tail says so', () => {
    const r = judgeReport(1, '', report({ success: true }))
    expect(r.exitCode).toBe(0)
    expect(r.tail).toBe('vitest exited 1 after the tests ran; its JSON report says all 3 passed, so the step passes')
    expect(judgeReport(null, 'RUN v3', report({ success: true })).tail).toBe('RUN v3\nvitest exited by signal after the tests ran; its JSON report says all 3 passed, so the step passes')
  })

  it("a run whose reporter printed its summary keeps its exit: the JSON report does not count an unhandled error", () => {
    const summary = 'Test Files  530 passed (530)\n      Tests  4966 passed (4966)\n     Errors  1 error'
    expect(judgeReport(1, summary, report({ success: true }))).toEqual({ exitCode: 1, tail: summary })
    // The summary seen earlier in the output, evicted from the kept tail by later lines: the exit still stands.
    expect(judgeReport(1, 'shutdown line', report({ success: true }), true)).toEqual({ exitCode: 1, tail: 'shutdown line' })
    expect(judgeReport(1, 'shutdown line', report({ success: true }), false).exitCode).toBe(0)
  })

  it('spawnStep reads the summary off whole lines: one split across two chunks still keeps the exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-gate-spawn-'))
    try {
      // A vitest stand-in: a green JSON report, the summary written in two chunks, an unhandled error, exit 1.
      const script = [
        "const out = process.argv.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length)",
        "require('fs').writeFileSync(out, JSON.stringify({ success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [] }))",
        "process.stdout.write(' Test ')",
        "setTimeout(() => process.stdout.write('Files  1 passed (1)\\n     Errors  1 error\\n', () => process.exit(1)), 80)"
      ].join('\n')
      // `--` ends node's own option parsing: the reporter flags the step appends reach the script.
      const step: Step = { name: 'vitest', tier: 'commit', cmd: process.execPath, args: ['-e', script, '--'], lane: 'vitest', why: '', json: true }
      const run = spawnStep({ repo: dir, logDir: join(dir, 'logs'), verbose: false })
      const { exitCode, tail } = await run(step, new AbortController().signal)
      expect(exitCode).toBe(1)
      expect(tail).toContain('Errors  1 error')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a red report names its failures when the output printed nothing, and keeps the output when it did', () => {
    const red = report({
      success: false,
      numFailedTests: 1,
      testResults: [{ name: 'src/x.test.ts', assertionResults: [{ fullName: 'x > boom', status: 'failed' }, { fullName: 'x > fine', status: 'passed' }] }]
    })
    expect(judgeReport(1, '', red)).toEqual({ exitCode: 1, tail: 'vitest printed nothing; its JSON report lists 1 failed\nFAIL src/x.test.ts > x > boom' })
    expect(judgeReport(1, 'FAIL x > boom\n(details)', red)).toEqual({ exitCode: 1, tail: 'FAIL x > boom\n(details)' })
  })

  it('no report and no output names the workers that never started; output without a report stands', () => {
    expect(judgeReport(1, '  \n', null)).toEqual({
      exitCode: 1,
      tail: 'vitest printed nothing and wrote no report: its workers never started (the host at its pids cap, or the pool could not spawn)'
    })
    expect(judgeReport(null, '', null).exitCode).toBe(1)
    expect(judgeReport(2, 'Error: Channel closed', null)).toEqual({ exitCode: 2, tail: 'Error: Channel closed' })
  })
})

describe('the whole suite runs only when asked for', () => {
  beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  const note = 'the building thread runs it before it lands (--full or --only vitest to run it here)'

  it('leaves vitest out of a plain tier run, and runs it under --full or an --only that names it', () => {
    expect(STEPS.find((s) => s.name === 'vitest')).toMatchObject({ tier: 'commit', whenAsked: true })
    expect(STEPS.filter((s) => s.whenAsked).map((s) => s.name)).toEqual(['vitest'])
    const commit = selectSteps({ tiers: new Set(['commit']) })
    expect([...whenAskedSkips(commit, { full: false })]).toEqual([['vitest', note]])
    expect(whenAskedSkips(commit, { full: true }).size).toBe(0)
    expect(whenAskedSkips(selectSteps({ tiers: new Set(['commit']), only: ['vitest'] }), { full: false, only: ['vitest'] }).size).toBe(0)
    expect(whenAskedSkips(commit, { full: false, only: ['typecheck', 'vitest'] }).size).toBe(0)
  })

  it('the gate reports the step skipped with its note, and runs it under --full', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tc-gate-asked-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo })
      const ran = join(repo, 'ran.txt')
      const steps: Step[] = [
        { name: 'vitest', tier: 'commit', lane: 'vitest', why: '', whenAsked: true, cmd: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(ran)}, 'yes')`] },
        { name: 'build', tier: 'commit', lane: 'build', why: '', cmd: process.execPath, args: ['-e', ''] }
      ]
      const plain = await gate({ repo, tiers: new Set(['commit']), full: false, verbose: false, steps })
      expect(plain.ok).toBe(true)
      expect(plain.results.map((r) => [r.name, r.outcome, r.note])).toEqual([
        ['vitest', 'skipped', note],
        ['build', 'passed', undefined]
      ])
      expect(existsSync(ran)).toBe(false)
      const full = await gate({ repo, tiers: new Set(['commit']), full: true, verbose: false, steps })
      expect(full.results[0].outcome).toBe('passed')
      expect(existsSync(ran)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('the guards row', () => {
  it('runs every repo-rule test in its own lane beside the build, and a plain commit tier keeps it', () => {
    const guards = STEPS.find((s) => s.name === 'guards')!
    expect(guards).toMatchObject({ tier: 'commit', lane: 'guards', env: { NODE_ENV: 'test' } })
    expect(guards.whenAsked).toBeUndefined()
    expect(guards.args).toEqual(['vitest', 'run', ...GUARD_TESTS])
    expect(whenAskedSkips(selectSteps({ tiers: new Set(['commit']) }), { full: false }).has('guards')).toBe(false)
  })

  it('names files that exist, and every guard test the tree holds', () => {
    const root = join(__dirname, '..')
    for (const f of GUARD_TESTS) expect(existsSync(join(root, f)), f).toBe(true)
    const tracked = execFileSync('git', ['ls-files', ':(glob)src/renderer/src/lib/*Guard.test.ts', ':(glob)scripts/*guard*.test.ts', ':(glob)scripts/*Guard*.test.ts'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
    expect(tracked.filter((f) => !(GUARD_TESTS as readonly string[]).includes(f))).toEqual([])
  })
})

describe('the proofs after a release', () => {
  const row = (name: string, paths: string[], lane = 'e2e'): Step => ({ name, tier: 'publish', lane, cmd: 'true', args: [], why: name, paths })
  const publishRows = STEPS.filter((s) => s.tier === 'publish')

  it('gives every publish row its ground, and every path that pulls the publish tier into a commit lands in some row', () => {
    for (const s of publishRows) expect(s.paths?.length, s.name).toBeGreaterThan(0)
    for (const rule of TIER_PATHS.filter((r) => r.tier === 'publish')) {
      // the rule's own pattern, as a path it names (a glob's literal stem stands for it)
      const sample = rule.pattern.replace('**', 'x/y.ts').replace('*', 'x')
      expect(publishRows.some((s) => rowTouched(s, [sample])), rule.pattern).toBe(true)
    }
  })

  it('covers every script a row runs: its entry and each scripts/ file it imports, however deep', () => {
    const root = join(__dirname, '..')
    const read = (f: string): string => readFileSync(join(root, f), 'utf8')
    const resolveImport = (from: string, spec: string): string | null => {
      const base = join(from, '..', spec)
      for (const c of [base, `${base}.ts`, `${base}.mjs`]) if (existsSync(join(root, c)) && /\.(ts|mjs)$/.test(c)) return c
      return null
    }
    // every script the row's command names, through package.json's runners (bundle-server, proof-bun)
    const entriesOf = (s: Step): string[] => {
      const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
      const words = s.args.flatMap((a) => (pkg.scripts[a] ?? a).split(/\s+/))
      return words.filter((w) => /^scripts\/[\w./-]+\.(ts|mjs)$/.test(w) && !w.startsWith('scripts/.out/'))
    }
    const missing: string[] = []
    for (const s of publishRows) {
      const seen = new Set<string>()
      const queue = entriesOf(s)
      while (queue.length) {
        const f = queue.pop()!
        if (seen.has(f) || !f.startsWith('scripts/')) continue
        seen.add(f)
        for (const m of read(f).matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
          const r = resolveImport(f, m[1])
          if (r) queue.push(r)
        }
      }
      missing.push(...[...seen].filter((f) => !rowTouched(s, [f])).map((f) => `${s.name} runs ${f}`))
    }
    expect(missing).toEqual([])
  })

  it('runs a row when its own paths or a path every row reads changed, and leaves it out otherwise', () => {
    const fence = STEPS.find((s) => s.name === 'e2e-remote-fence')!
    const soak = STEPS.find((s) => s.name === 'renderer-soak')!
    expect(rowTouched(fence, ['src/main/server/remote/fence.ts'])).toBe(true)
    expect(rowTouched(fence, ['src/renderer/src/App.tsx', 'docs/box.md'])).toBe(false)
    expect(rowTouched(soak, ['src/renderer/src/App.tsx'])).toBe(true)
    // the version bump every release makes is no row's change
    for (const s of publishRows) expect(rowTouched(s, ['package.json', 'docs/release-gate.md', 'PROJECT.md']), s.name).toBe(false)
    for (const p of EVERY_ROW_PATHS) for (const s of publishRows) expect(rowTouched(s, [p]), `${s.name} ${p}`).toBe(true)
  })

  it('counts a row from its last pass while HEAD holds it, else from the last release', () => {
    expect(rowBase('abc', 'v1.0.362', () => true)).toBe('abc')
    expect(rowBase('abc', 'v1.0.362', () => false)).toBe('v1.0.362')
    expect(rowBase(undefined, 'v1.0.362', () => true)).toBe('v1.0.362')
  })

  it('selects the rows a release touched, keeps a red row running until it passes, and runs all with no release to count from', () => {
    const steps = [row('fence', ['src/main/server/remote/**']), row('hub', ['infra/hub/**']), row('ios', ['ios/**']), { ...row('vitest', []), tier: 'commit' as const }]
    const changed: Record<string, string[]> = {
      'v1.0.362': ['infra/hub/src/index.ts', 'package.json'],
      // the fence passed long ago, before the remote change that went red at the last release
      old: ['src/main/server/remote/fence.ts', 'infra/hub/src/index.ts', 'package.json']
    }
    const skips = rowSkips(steps, 'v1.0.362', { fence: 'old', ios: 'gone' }, (sha) => sha === 'old', (ref) => changed[ref] ?? [])
    expect([...skips]).toEqual([['ios', 'no change to its paths since v1.0.362']])
    // a ref git cannot read counts as every path changed
    expect(rowSkips(steps, 'v1.0.362', {}, () => false, () => null).size).toBe(0)
    expect(rowSkips(steps, '', {}, () => false, () => []).size).toBe(0)
    // a row's last pass newer than the release, with nothing since, leaves it out
    expect(rowSkips([row('hub', ['infra/hub/**'])], 'v1.0.362', { hub: 'newer' }, () => true, (ref) => (ref === 'newer' ? [] : ['infra/hub/a.ts'])).get('hub')).toBe(
      'no change to its paths since its last pass at newer'
    )
  })

  it('keeps each publish row’s last pass by HEAD, and never a commit row’s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-gate-green-'))
    try {
      const steps = [row('fence', []), row('hub', []), { ...row('vitest', []), tier: 'commit' as const }]
      storeRowsGreen(dir, 'aaa', [{ name: 'fence', outcome: 'passed', ms: 1 }, { name: 'hub', outcome: 'failed', ms: 1 }, { name: 'vitest', outcome: 'passed', ms: 1 }], steps)
      storeRowsGreen(dir, 'bbb', [{ name: 'hub', outcome: 'passed', ms: 1 }], steps)
      expect(readRowsGreen(dir)).toEqual({ fence: 'aaa', hub: 'bbb' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs every other row after a failure, then the failed row once more alone, and says how its second try went', async () => {
    const steps = [row('a', [], 'x'), row('b', [], 'y'), row('c', [], 'x'), row('d', [], 'z')]
    const tries = new Map<string, number>()
    const log: string[] = []
    let running = 0
    let aloneOk = true
    const retried: string[] = []
    const report = await runSteps(
      steps,
      async (s) => {
        const n = (tries.get(s.name) ?? 0) + 1
        tries.set(s.name, n)
        running++
        if (n === 2 && running > 1) aloneOk = false
        await new Promise((r) => setTimeout(r, 5))
        running--
        log.push(`${s.name}#${n}`)
        // a fails once and passes; d fails twice
        if (s.name === 'a') return { exitCode: n === 1 ? 1 : 0, tail: '' }
        if (s.name === 'd') return { exitCode: 1, tail: `boom ${n}` }
        return { exitCode: 0, tail: '' }
      },
      { onRetry: (s, first) => retried.push(`${s.name}:${first.outcome}`) },
      new Map(),
      { retry: true }
    )
    // c ran after a failed in its own lane; both retries came after every first try, alone
    expect(log.slice(0, 4).sort()).toEqual(['a#1', 'b#1', 'c#1', 'd#1'])
    expect(log.slice(4)).toEqual(['a#2', 'd#2'])
    expect(aloneOk).toBe(true)
    expect(retried).toEqual(['a:failed', 'd:failed'])
    expect(report.ok).toBe(false)
    const by = Object.fromEntries(report.results.map((r) => [r.name, r]))
    expect(by.a).toMatchObject({ outcome: 'passed', note: SECOND_TRY_PASSED })
    expect(by.c.outcome).toBe('passed')
    expect(by.d).toMatchObject({ outcome: 'failed', note: SECOND_TRY_FAILED, tail: 'boom 2' })
    expect(formatReport(report)).toContain(`a  `)
  })

  it('without retry, a failure still stops the gate and nothing runs twice', async () => {
    const tries: string[] = []
    const report = await runSteps([row('a', [], 'x'), row('c', [], 'x')], async (s) => {
      tries.push(s.name)
      return { exitCode: 1, tail: '' }
    })
    expect(tries).toEqual(['a'])
    expect(report.results.map((r) => r.outcome)).toEqual(['failed', 'not run'])
  })

  it('says which rows need a word and how the proofs phase ended', () => {
    const report = (results: Report['results'], ok = true): Report => ({ ok, ms: 125_000, results })
    const untouched = new Set(['hub', 'ios'])
    const mixed = report(
      [
        { name: 'fence', outcome: 'passed', ms: 1 },
        { name: 'addons', outcome: 'passed', ms: 1, note: SECOND_TRY_PASSED },
        { name: 'skills', outcome: 'failed', ms: 1, exitCode: 1, note: SECOND_TRY_FAILED },
        { name: 'tc', outcome: 'skipped', ms: 0, note: 'the screen is locked' },
        { name: 'hub', outcome: 'skipped', ms: 0, note: 'no change to its paths since v1.0.362' }
      ],
      false
    )
    expect(proofLines(mixed, '/g/logs', 'v1.0.362', untouched)).toEqual([
      `proof ✓ addons ${SECOND_TRY_PASSED}`,
      `proof ✗ skills ${SECOND_TRY_FAILED}, log /g/logs/skills.log`,
      'proof – tc the screen is locked'
    ])
    expect(proofsPhaseLine(mixed)).toBe('phase ✗ proofs 2m5s')
    const none = report([{ name: 'hub', outcome: 'skipped', ms: 0 }, { name: 'ios', outcome: 'skipped', ms: 0 }])
    expect(proofLines(none, '/g/logs', 'v1.0.362', untouched)).toEqual(["proof – no row's paths changed since v1.0.362"])
    expect(proofsPhaseLine(none)).toBe('phase – proofs skipped')
    expect(proofsPhaseLine(report([{ name: 'fence', outcome: 'passed', ms: 1 }]))).toBe('phase ✓ proofs 2m5s')
    expect(fmtPhase(42_000)).toBe('42s')
    expect(fmtPhase(71_000)).toBe('1m11s')
  })

  it('takes --after-release, with an empty ref for every row', () => {
    expect(parseArgs(['--tier', 'publish', '--after-release', 'v1.0.362']).afterRelease).toBe('v1.0.362')
    expect(parseArgs(['--after-release=']).afterRelease).toBe('')
    expect(parseArgs(['--tier', 'publish']).afterRelease).toBeUndefined()
  })

  it('runs only the touched rows in a real repo and prints the proofs phase', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tc-gate-after-'))
    const out: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => void out.push(String(l)))
    try {
      const g = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
      g('init', '-q')
      g('config', 'user.email', 't@t')
      g('config', 'user.name', 't')
      mkdirSync(join(repo, 'infra/hub'), { recursive: true })
      writeFileSync(join(repo, 'infra/hub/a.ts'), '1')
      g('add', '.')
      g('commit', '-qm', 'one')
      g('tag', 'v1.0.1')
      writeFileSync(join(repo, 'infra/hub/a.ts'), '2')
      g('commit', '-qam', 'two')
      const steps: Step[] = [
        { ...row('hub', ['infra/hub/**']), cmd: process.execPath, args: ['-e', ''] },
        { ...row('ios', ['ios/**']), cmd: process.execPath, args: ['-e', 'process.exit(1)'] }
      ]
      const report = await gate({ repo, tiers: new Set(['publish']), full: false, verbose: false, steps, afterRelease: 'v1.0.1' })
      expect(report.results.map((r) => [r.name, r.outcome])).toEqual([['hub', 'passed'], ['ios', 'skipped']])
      expect(out[0]).toBe('phase › proofs')
      expect(out.at(-1)).toMatch(/^phase ✓ proofs \d+s$/)
      expect(readRowsGreen(gateDir(repo))).toEqual({ hub: g('rev-parse', 'HEAD').trim() })
      // the next release, with nothing new, runs no row and says so
      out.length = 0
      const again = await gate({ repo, tiers: new Set(['publish']), full: false, verbose: false, steps, afterRelease: 'HEAD' })
      expect(again.results.every((r) => r.outcome === 'skipped')).toBe(true)
      expect(out.slice(-2)).toEqual(["proof – no row's paths changed since HEAD", 'phase – proofs skipped'])
    } finally {
      spy.mockRestore()
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
