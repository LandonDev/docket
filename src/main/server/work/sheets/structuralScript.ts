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
  {"op": "moveRange", "sheet": name, "r1", "c1", "r2", "c2", "to": name, "row", "col"}
  {"op": "moveRows"|"moveCols", "sheet": name, "at": n, "count": n, "to": n}   ("to": the row or column the block
      goes before, counted as the sheet stood before the move: the grid's own count)
Prints {"ok": true}, or exits non-zero with the reason on stderr ("protected: <sheet>" for a protected sheet,
"unmoved: <sheet>" for a move LibreOffice did not make).
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


CONTENTS = 1 | 2 | 4 | 16  # values, dates, text, formulas


def filled(sheet, r1, c1, r2, c2):
    """The cells of a block that hold something, relative to its top left."""
    out = set()
    found = sheet.getCellRangeByPosition(c1, r1, c2, r2).queryContentCells(CONTENTS)
    for a in found.getRangeAddresses():
        for r in range(a.StartRow, a.EndRow + 1):
            for c in range(a.StartColumn, a.EndColumn + 1):
                out.add((r - r1, c - c1))
    return out


def move(doc, si, r1, c1, r2, c2, ti, row, col):
    """LibreOffice's moveRange, checked: it has been seen to leave a block where it was and say nothing (several
    LibreOffices at once on the box), and a move that did not happen must never be saved."""
    src, dst = doc.Sheets.getByIndex(si), doc.Sheets.getByIndex(ti)
    had = filled(src, r1, c1, r2, c2)
    dest = CellAddress()
    dest.Sheet, dest.Column, dest.Row = ti, col, row
    src.moveRange(dest, rng(si, r1, c1, r2, c2))
    h, w = r2 - r1, c2 - c1
    landed = filled(dst, row, col, row + h, col + w)
    left = {(r, c) for (r, c) in filled(src, r1, c1, r2, c2)
            if not (si == ti and row <= r1 + r <= row + h and col <= c1 + c <= col + w)}
    if landed != had or left:
        raise RuntimeError("unmoved: " + doc.Sheets.getByIndex(si).Name)


def move_lines(doc, op):
    """Rows or columns moved as Excel's Shift-drag moves them: the others close up behind and open up in front.
    LibreOffice has no such call, so: insert room before "to", move the block into it (every formula, name and
    chart range that points at the block follows), take the emptied lines out, and give the moved lines the
    heights or widths and the hidden state they had."""
    rows = op["op"] == "moveRows"
    si = index_of(doc, op["sheet"])
    sh = doc.Sheets.getByIndex(si)
    if sh.isProtected():
        raise RuntimeError("protected: " + op["sheet"])
    at, n, to = int(op["at"]), int(op["count"]), int(op["to"])
    if at <= to <= at + n:
        return
    lines = sh.Rows if rows else sh.Columns
    cur = sh.createCursor()
    cur.gotoEndOfUsedArea(False)
    end = cur.RangeAddress.EndRow if rows else cur.RangeAddress.EndColumn
    if end + n > lines.Count - 1:
        raise RuntimeError("full: " + op["sheet"])
    keys = ("Height", "IsVisible", "OptimalHeight") if rows else ("Width", "IsVisible", "OptimalWidth")
    kept = [dict((k, lines.getByIndex(at + i).getPropertyValue(k)) for k in keys) for i in range(n)]
    lines.insertByIndex(to, n)
    src = at if to > at else at + n
    last_row, last_col = sh.Rows.Count - 1, sh.Columns.Count - 1
    if rows:
        move(doc, si, src, 0, src + n - 1, last_col, si, to, 0)
    else:
        move(doc, si, 0, src, last_row, src + n - 1, si, 0, to)
    lines.removeByIndex(src, n)
    first = to - n if to > at else to
    for i, props_of in enumerate(kept):
        line = lines.getByIndex(first + i)
        # (an optimal height or width set first, so a fixed one he gave is not worked out again over it)
        for k in keys[::-1]:
            line.setPropertyValue(k, props_of[k])


def move_block(doc, op):
    """A block cut and dropped elsewhere, on its sheet or another: LibreOffice's moveRange, which takes the cells'
    contents, formats, notes, merges and rules with them and points every reference to the block at its new place.
    What stood where it lands is gone, as in Excel."""
    si = index_of(doc, op["sheet"])
    ti = index_of(doc, op["to"])
    for i, name in ((si, op["sheet"]), (ti, op["to"])):
        if doc.Sheets.getByIndex(i).isProtected():
            raise RuntimeError("protected: " + name)
    r1, c1, r2, c2 = int(op["r1"]), int(op["c1"]), int(op["r2"]), int(op["c2"])
    move(doc, si, r1, c1, r2, c2, ti, int(op["row"]), int(op["col"]))


def apply(doc, op):
    kind = op["op"]
    if kind in ("moveRows", "moveCols"):
        return move_lines(doc, op)
    if kind == "moveRange":
        return move_block(doc, op)
    if kind in ("insertRows", "removeRows", "insertCols", "removeCols"):
        sh = doc.Sheets.getByName(op["sheet"])
        if sh.isProtected():
            raise RuntimeError("protected: " + op["sheet"])
        at, n = int(op["at"]), int(op["count"])
        if kind in ("insertRows", "insertCols"):
            # As Excel: an insert that would push cells off the end of the sheet is refused.
            cur = sh.createCursor()
            cur.gotoEndOfUsedArea(False)
            end = cur.RangeAddress.EndRow if kind == "insertRows" else cur.RangeAddress.EndColumn
            limit = (sh.Rows.Count if kind == "insertRows" else sh.Columns.Count) - 1
            if end + n > limit:
                raise RuntimeError("full: " + op["sheet"])
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
        if op["to"] not in doc.Sheets.ElementNames:
            raise RuntimeError("LibreOffice did not rename " + op["sheet"])
    else:
        raise RuntimeError("unknown op " + kind)


def main():
    src, dst, ops_path, profile = sys.argv[1:5]
    ops = json.load(open(ops_path))
    proc, desktop = start(profile)
    try:
        url = uno.systemPathToFileUrl(os.path.abspath(src))
        doc = desktop.loadComponentFromURL(url, "_blank", 0, props(Hidden=True))
        if doc is None:
            # A full 1,048,576-row sheet loads only read-only, as the research lab loaded every file. The
            # document still takes most edits (not a rename); it is stored elsewhere, never over its source.
            doc = desktop.loadComponentFromURL(url, "_blank", 0, props(Hidden=True, ReadOnly=True))
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
