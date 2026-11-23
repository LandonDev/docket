import { existsSync, mkdirSync, readdirSync, renameSync, copyFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkModule } from '../modules'
import { runnerOf, type Converter } from './jobs'
import { formatsHealth } from './health'
import { formatsPillar } from './pillar'
import { tailOf, toolsRoot } from './tools'

/**
 * The formats pillar's server module (docs/agents/work-formats.md).
 * Milestone 15 wrote the toolchain's part: `work.formats.tools`,
 * `work.formats.convert` (a job another host forwards here) and the
 * LibreOffice converters every pillar's jobs go through. Milestone 21 adds
 * import and export in its own file, ./pillar.ts, merged in below.
 */

/** What LibreOffice converts among, by family: any member to any other of its family, and every member to PDF. */
const LIBREOFFICE_FAMILIES: Record<string, string[]> = {
  text: ['docx', 'odt', 'rtf', 'doc'],
  slides: ['pptx', 'odp', 'ppt'],
  sheet: ['xlsx', 'ods', 'xls', 'csv']
}

/**
 * What a slot's profile starts with: no macro runs, and nothing a document
 * links to is fetched on a referer it does not trust. LibreOffice 26.8's
 * headless conversion already leaves linked images and sections out (checked
 * on the box: a `file://` and an `http://` image, a linked section); this
 * says so in the profile rather than leaning on a default.
 */
export const LIBREOFFICE_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
`
const LIBREOFFICE_MAX_MS = 10 * 60_000
/** A filter name as LibreOffice spells them (`MS Word 2007 XML`, `writer_pdf_Export`), with its options after a colon. */
const FILTER = /^[\w .()"',:{}-]{1,160}$/

/** One LibreOffice job: `soffice --convert-to`, with the profile of the job's slot so two jobs never share one. */
export function libreOffice(from: string, to: string): Converter {
  return {
    from,
    to,
    needs: 'libreoffice',
    threads: 1,
    async run(job, run) {
      const soffice = run.tools.bin('libreoffice')
      if (!soffice) throw new Error('libreoffice is not installed here')
      const profile = join(toolsRoot(run.tools.dataDir), 'run', `libreoffice-profile-v1-${run.slot}`)
      const seeded = join(profile, 'user', 'registrymodifications.xcu')
      if (!existsSync(seeded)) {
        mkdirSync(join(profile, 'user'), { recursive: true })
        writeFileSync(seeded, LIBREOFFICE_PROFILE)
      }
      // soffice names its output after its input: a copy with the right extension in the job's scratch folder keeps the name ours.
      const input = join(run.tmp, `input.${from}`)
      copyFileSync(job.input, input)
      const outdir = join(run.tmp, 'out')
      mkdirSync(outdir)
      // Options may come from another host's key: a filter is a name, and a job's time is bounded.
      const named = job.options?.filter
      if (named !== undefined && (typeof named !== 'string' || !FILTER.test(named))) throw new Error('not a LibreOffice filter name')
      const filter = named ? `${to}:${named}` : to
      const asked = job.options?.timeoutMs
      const timeoutMs = typeof asked === 'number' && asked > 0 ? Math.min(asked, LIBREOFFICE_MAX_MS) : 5 * 60_000
      const r = await run.run(soffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore', '--nologo', '--nodefault', '--convert-to', filter, '--outdir', outdir, input], { timeoutMs, cwd: run.tmp })
      const made = existsSync(outdir) ? readdirSync(outdir).find((f) => extname(f).toLowerCase() === `.${to}`) : undefined
      if (r.code !== 0 || !made) throw new Error(`libreoffice could not convert ${basename(job.input)} to ${to}: ${tailOf(r.out) || `exit ${r.code}`}`)
      try {
        renameSync(join(outdir, made), job.output)
      } catch {
        copyFileSync(join(outdir, made), job.output)
      }
      return {}
    }
  }
}

export const LIBREOFFICE_CONVERTERS: Converter[] = Object.values(LIBREOFFICE_FAMILIES).flatMap((family) =>
  family.flatMap((from) => [...family.filter((to) => to !== from), 'pdf'].map((to) => libreOffice(from, to)))
)

export const formats: WorkModule = {
  ...formatsPillar,
  id: 'formats',
  ensure(db) {
    formatsPillar.ensure?.(db)
  },
  async handle(req, ctx, by) {
    if (req.method === 'work.formats.tools') {
      const runner = await runnerOf(ctx)
      if (!runner) throw new Error('the job runner is not up')
      return handled(await runner.report())
    }
    if (req.method === 'work.formats.convert') {
      const runner = await runnerOf(ctx)
      if (!runner) throw new Error('the job runner is not up')
      return handled(await runner.serveForwarded(req.params))
    }
    return formatsPillar.handle ? formatsPillar.handle(req, ctx, by) : NOT_HANDLED
  },
  convert: [...LIBREOFFICE_CONVERTERS, ...(formatsPillar.convert ?? [])],
  // Connections: the conversion tools this host has, and each that did not install.
  health: formatsHealth
}
