/**
 * The LibreOffice side of a structural edit on an opened package
 * (docs/agents/work-sheets.md "Structural edits"): run by structural.ts's
 * converter with LibreOffice's own Python (it has `uno`), written into the
 * job's scratch folder. As `String.raw`, the Python is kept as written.
 */
export const STRUCTURAL_PY = String.raw`"""Apply structural edits to a workbook in headless LibreOffice and save it as the same kind.

    <LibreOffice>/program/python structural.py <in> <out> <ops.json> <profile-dir>

ops.json: a list, applied in order; rows and columns count from zero:
  {"op": "insertRows"|"removeRows"|"insertCols"|"removeCols", "sheet": name, "at": n, "count": n}
  {"op": "reorder", "sheet": name, "r1", "c1", "r2", "c2", "order": {"targetRow": sourceRow}}
  {"op": "addSheet", "name": name, "at": index}   {"op": "removeSheet", "sheet": name}
  {"op": "renameSheet", "sheet": name, "to": name}
Prints {"ok": true}, or exits non-zero with the reason on stderr ("protected: <sheet>" for a protected sheet).
Cell contents never come here: the patch writer writes them (sheets/structural.ts).
"""
import json, os, subprocess, sys, time, uuid

import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.connection import NoConnectException
from com.sun.star.table import CellAddress, CellRangeAddress

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


def rng(sheet, r1, c1, r2, c2):
    a = CellRangeAddress()
    a.Sheet, a.StartRow, a.StartColumn, a.EndRow, a.EndColumn = sheet, r1, c1, r2, c2
    return a


def index_of(doc, name):
    names = list(doc.Sheets.ElementNames)
    if name not in names:
        raise RuntimeError("no sheet named " + name)
    return names.index(name)


def apply(doc, op):
    kind = op["op"]
    if kind in ("insertRows", "removeRows", "insertCols", "removeCols"):
        sh = doc.Sheets.getByName(op["sheet"])
        if sh.isProtected():
            raise RuntimeError("protected: " + op["sheet"])
        at, n = int(op["at"]), int(op["count"])
        if kind == "insertRows":
            sh.Rows.insertByIndex(at, n)
        elif kind == "removeRows":
            sh.Rows.removeByIndex(at, n)
        elif kind == "insertCols":
            sh.Columns.insertByIndex(at, n)
        else:
            sh.Columns.removeByIndex(at, n)
    elif kind == "reorder":
        # A sort as the grid made it: each target row takes its source row's cells, formats and
        # formula text as they were, through a scratch sheet.
        si = index_of(doc, op["sheet"])
        sh = doc.Sheets.getByIndex(si)
        if sh.isProtected():
            raise RuntimeError("protected: " + op["sheet"])
        r1, c1, r2, c2 = int(op["r1"]), int(op["c1"]), int(op["r2"]), int(op["c2"])
        scratch = "tc-sort-" + uuid.uuid4().hex[:8]
        doc.Sheets.insertNewByName(scratch, doc.Sheets.Count)
        ti = index_of(doc, scratch)
        src = sh.getCellRangeByPosition(c1, r1, c2, r2)
        formulas = src.getFormulaArray()
        dest = CellAddress()
        dest.Sheet, dest.Column, dest.Row = ti, c1, r1
        sh.copyRange(dest, rng(si, r1, c1, r2, c2))
        tmp = doc.Sheets.getByIndex(ti)
        for target, source in op["order"].items():
            t, s = int(target), int(source)
            at = CellAddress()
            at.Sheet, at.Column, at.Row = si, c1, t
            tmp.copyRange(at, rng(ti, s, c1, s, c2))
            sh.getCellRangeByPosition(c1, t, c2, t).setFormulaArray((formulas[s - r1],))
        doc.Sheets.removeByName(scratch)
    elif kind == "addSheet":
        doc.Sheets.insertNewByName(op["name"], min(int(op.get("at", doc.Sheets.Count)), doc.Sheets.Count))
    elif kind == "removeSheet":
        doc.Sheets.removeByName(op["sheet"])
    elif kind == "renameSheet":
        doc.Sheets.getByName(op["sheet"]).setName(op["to"])
    else:
        raise RuntimeError("unknown op " + kind)


def main():
    src, dst, ops_path, profile = sys.argv[1:5]
    ops = json.load(open(ops_path))
    proc, desktop = start(profile)
    try:
        doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(os.path.abspath(src)), "_blank", 0, props(Hidden=True))
        if doc is None:
            raise RuntimeError("LibreOffice could not open the file")
        for op in ops:
            apply(doc, op)
        doc.calculateAll()
        filt = "Calc MS Excel 2007 VBA XML" if dst.lower().endswith(".xlsm") else "Calc Office Open XML"
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
    print(json.dumps({"ok": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(str(e)[:1000] + "\n")
        sys.exit(1)
`
