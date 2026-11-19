#!/usr/bin/env bun
import { join } from 'node:path'
import { platformOf, type Platform } from '../../src/main/server/work/formats/tools'
import { install, loadManifests, readState } from './installer'

/**
 * Install the Work conversion toolchain on this host, with no root
 * (docs/agents/work-formats.md, "The toolchain"):
 *
 *   bun scripts/work-tools/install.ts --data <userData> [--only libreoffice,python] [--force]
 *                                     [--manifests <dir>] [--keep-downloads] [--not-gentle]
 *   bun scripts/work-tools/install.ts --data <userData> --plan     what would be installed, and how big
 *   bun scripts/work-tools/install.ts --data <userData> --list     what state.json says
 *
 * `--data` defaults to TEMP_CODE_USER_DATA. Children run at nice 19 (and idle
 * disk priority on Linux) unless --not-gentle.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string): boolean => process.argv.includes(name)

async function main(): Promise<number> {
  const dataDir = arg('--data') ?? process.env.TEMP_CODE_USER_DATA
  if (!dataDir) {
    console.error('install.ts: name the host\'s userData with --data (or TEMP_CODE_USER_DATA)')
    return 2
  }
  const platform = (arg('--platform') as Platform | undefined) ?? platformOf()
  if (!platform) {
    console.error(`install.ts: ${process.platform}-${process.arch} is not a platform the manifests name`)
    return 2
  }
  const manifestsDir = arg('--manifests') ?? join(import.meta.dirname, '.')
  if (flag('--list')) {
    for (const t of Object.values(readState(dataDir, platform).tools)) console.log(`${t.ok ? 'ok  ' : 'no  '} ${t.name} ${t.version} [${t.pillar}] ${t.licence}${t.error ? ` — ${t.error}` : ''}`)
    return 0
  }
  if (flag('--plan')) {
    for (const t of loadManifests(manifestsDir)) {
      const e = t.platforms[platform]
      const bytes = (e?.files ?? []).reduce((n, f) => n + (f.size ?? 0), 0)
      console.log(`${t.name} ${t.version} [${t.pillar}, ${t.file}] ${e ? `${e.kind}, ${Math.round(bytes / 1048576)} MB to download` : `not offered on ${platform}`} — ${t.licence}`)
    }
    return 0
  }
  const only = arg('--only')?.split(',').filter(Boolean)
  const { failed } = await install({
    dataDir,
    manifestsDir,
    platform,
    ...(only ? { only } : {}),
    force: flag('--force'),
    keepDownloads: flag('--keep-downloads'),
    gentle: !flag('--not-gentle')
  })
  if (failed.length) console.error(`did not install: ${failed.join(', ')}`)
  return failed.length ? 1 : 0
}

if (import.meta.main) process.exit(await main())
