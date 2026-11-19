#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool, Toolchain } from '../../src/main/server/work/formats/tools'

/**
 * The `packages` lines of a pip tool's manifest entry: the whole closure of
 * what you name, each pinned with every wheel's sha256 from PyPI, so the
 * installer's `pip install --require-hashes --no-deps` fetches exactly that.
 *
 *   bun scripts/work-tools/pip-lock.ts --data <userData> python-pptx==1.0.2 [more…]
 *
 * It resolves the closure in a scratch venv made from the python tool the
 * installer left in <userData>, prints the lines as a JSON array, and removes
 * the scratch venv. Wheels only: a package with no wheel for a version is
 * named on stderr and the run exits 1.
 */
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const dataDir = arg('--data') ?? process.env.TEMP_CODE_USER_DATA
const wanted = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--data')
const python = dataDir ? new Toolchain(dataDir).bin('python') : null
if (!python || !wanted.length) {
  console.error('usage: pip-lock.ts --data <userData with the python tool installed> <requirement>…')
  process.exit(2)
}

const scratch = mkdtempSync(join(tmpdir(), 'tc-pip-lock-'))
try {
  const venv = join(scratch, 'venv')
  const py = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  for (const [cmd, args] of [
    [python, ['-I', '-m', 'venv', venv]],
    [py, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', ...wanted]]
  ] as const) {
    const r = await runTool(cmd, [...args], { timeoutMs: 30 * 60_000 })
    if (r.code !== 0) throw new Error(`${args.join(' ')}: ${r.out.slice(-800)}`)
  }
  const freeze = await runTool(py, ['-I', '-m', 'pip', 'freeze', '--all', '--disable-pip-version-check'])
  const pins = freeze.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9._-]+==/.test(l) && !/^(pip|setuptools|wheel)==/i.test(l))
  const lines: string[] = []
  let missing = false
  for (const pin of pins) {
    const [name, version] = pin.split('==')
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`)
    if (!res.ok) throw new Error(`${pin}: PyPI said ${res.status}`)
    const info = (await res.json()) as { urls: { packagetype: string; digests: { sha256: string } }[] }
    const hashes = info.urls.filter((u) => u.packagetype === 'bdist_wheel').map((u) => `--hash=sha256:${u.digests.sha256}`)
    if (!hashes.length) {
      console.error(`${pin}: no wheel on PyPI`)
      missing = true
      continue
    }
    lines.push(`${name}==${version} ${hashes.join(' ')}`)
  }
  console.log(JSON.stringify(lines, null, 2))
  process.exitCode = missing ? 1 : 0
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
