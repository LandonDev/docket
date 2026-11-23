import { copyFileSync, existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Converter } from '../formats/jobs'
import { officePython } from './structural'

/**
 * A copy written back as the format it was (formatsIn.ts "Save back"): `xlsx → xls+calc` and
 * `xlsx → ods+calc`. LibreOffice reads an .xlsx with the results it finds beside each formula and
 * does not work them out again, and an edit the patch writer saved without its engine leaves those
 * results as they were; written out that way, the file would show sums from before the edit. So
 * this pair loads the copy, recalculates every formula, and only then stores it, through
 * LibreOffice's own Python as the structural converter does. Macros never run: the copy holds
 * none, and the document is loaded with their execution off.
 */
const FILTERS = { xls: 'MS Excel 97', ods: 'calc8' } as const
export type BackFormat = keyof typeof FILTERS
export const backTarget = (format: BackFormat): string => `${format}+calc`

const LIBREOFFICE_MS = 10 * 60_000

export const SHEET_BACK_PY = String.raw`"""Recalculate a workbook in headless LibreOffice and store it in another format.

    <LibreOffice>/program/python back.py <in.xlsx> <out> <filter-name> <profile-dir>
"""
import os, subprocess, sys, time, uuid

import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.connection import NoConnectException

SOFFICE = os.path.join(os.path.dirname(os.path.realpath(uno.__file__)), "soffice")


def props(**kw):
    out = []
    for k, v in kw.items():
        p = PropertyValue()
        p.Name, p.Value = k, v
        out.append(p)
    return tuple(out)


def start(profile):
    pipe = "tcsheet" + uuid.uuid4().hex
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    env["SAL_ENABLE_FILE_LOCKING"] = "0"
    proc = subprocess.Popen(
        [SOFFICE, "--headless", "--invisible", "--nologo", "--norestore", "--nodefault",
         "-env:UserInstallation=" + uno.systemPathToFileUrl(profile),
         "--accept=pipe,name=%s;urp;StarOffice.ComponentContext" % pipe],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    deadline = time.time() + 90
    while True:
        try:
            ctx = resolver.resolve("uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe)
            break
        except NoConnectException:
            if time.time() > deadline or proc.poll() is not None:
                raise RuntimeError("LibreOffice did not start")
            time.sleep(0.2)
    return proc, ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)


def main():
    src, dst, filt, profile = sys.argv[1:5]
    proc, desktop = start(profile)
    try:
        url = uno.systemPathToFileUrl(os.path.abspath(src))
        # MacroExecutionMode 0: never.
        doc = desktop.loadComponentFromURL(url, "_blank", 0, props(Hidden=True, MacroExecutionMode=0))
        if doc is None:
            doc = desktop.loadComponentFromURL(url, "_blank", 0, props(Hidden=True, ReadOnly=True, MacroExecutionMode=0))
        if doc is None:
            raise RuntimeError("LibreOffice could not open the copy")
        doc.calculateAll()
        doc.storeToURL(uno.systemPathToFileUrl(os.path.abspath(dst)), props(FilterName=filt, Overwrite=True))
        doc.close(True)
    finally:
        try:
            desktop.terminate()
        except Exception:
            pass
        try:
            proc.wait(timeout=30)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(str(e)[:1000] + "\n")
        sys.exit(1)
`

/** The pairs the sheets module adds to the runner (`WorkModule.convert`). They run where LibreOffice is installed and follow the runner's rules (a shared file's copy is never carried to another host). */
export const SHEET_BACK_CONVERTERS: Converter[] = (Object.keys(FILTERS) as BackFormat[]).map((format) => ({
  from: 'xlsx',
  to: backTarget(format),
  needs: 'libreoffice',
  threads: 1,
  async run(job, run) {
    const soffice = run.tools.bin('libreoffice')
    if (!soffice) throw new Error('libreoffice is not installed here')
    const python = officePython(soffice)
    if (!python) throw new Error("LibreOffice's Python is not installed here")
    const script = join(run.tmp, 'back.py')
    // LibreOffice gets a copy of its own to open: the package store may be saving into the first.
    const input = join(run.tmp, 'input.xlsx')
    const out = join(run.tmp, `out.${format}`)
    writeFileSync(script, SHEET_BACK_PY)
    copyFileSync(job.input, input)
    const r = await run.run(python, [script, input, out, FILTERS[format], join(run.tmp, 'profile')], { timeoutMs: LIBREOFFICE_MS, cwd: run.tmp })
    if (r.code !== 0 || !existsSync(out)) throw new Error(`LibreOffice could not write the .${format}: ${r.out.trim().split('\n').pop() || `exit ${r.code}`}`)
    try {
      renameSync(out, job.output)
    } catch {
      copyFileSync(out, job.output)
    }
    return {}
  }
}))
