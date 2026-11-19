"""Open a workbook in headless LibreOffice, optionally set one cell, recalculate
everything, and dump every non-empty cell's value per sheet.

    $LO/program/python lo_dump.py <in.xlsx> <out.json> [--edit SHEET A1 VALUE] [--csv DIR]

out.json: {"sheets": {name: {A1: [kind, value, shown]}}, "openMs", "calcMs"}
kind is n (number), s (text) or e (error). `shown` is the formatted string; it
is filled only for sheets under SHOWN_LIMIT cells (one UNO call per cell).
--csv also writes one CSV per sheet (the recalculated values) for eyeballing.
"""
import csv, json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lo_uno import Office, set_cell  # noqa: E402

SHOWN_LIMIT = 60000
FORMULA = 16  # com.sun.star.sheet.CellFlags.FORMULA


def col_name(c):
    s = ""
    c += 1
    while c:
        c, r = divmod(c - 1, 26)
        s = chr(65 + r) + s
    return s


def dump(doc):
    out = {}
    for sh in doc.Sheets:
        cur = sh.createCursor()
        cur.gotoEndOfUsedArea(False)
        last_r, last_c = cur.RangeAddress.EndRow, cur.RangeAddress.EndColumn
        cells = {}
        rng = sh.getCellRangeByPosition(0, 0, last_c, last_r)
        arr = rng.getDataArray()
        n = (last_r + 1) * (last_c + 1)
        small = n <= SHOWN_LIMIT
        errors = set()
        if small:
            q = rng.queryContentCells(FORMULA)
            for addr in q.RangeAddresses:
                for r in range(addr.StartRow, addr.EndRow + 1):
                    for c in range(addr.StartColumn, addr.EndColumn + 1):
                        if sh.getCellByPosition(c, r).getError():
                            errors.add((r, c))
        for r, row in enumerate(arr):
            for c, v in enumerate(row):
                if v == "" and (r, c) not in errors:
                    continue
                ref = col_name(c) + str(r + 1)
                shown = sh.getCellByPosition(c, r).getString() if small else None
                if (r, c) in errors:
                    cells[ref] = ["e", shown, shown]
                elif isinstance(v, float):
                    cells[ref] = ["n", v, shown]
                else:
                    cells[ref] = ["s", v, shown]
        out[sh.Name] = cells
    return out


def main():
    a = sys.argv[1:]
    src, dst = a[0], a[1]
    edit = None
    csvdir = None
    if "--edit" in a:
        i = a.index("--edit")
        edit = a[i + 1:i + 4]
    if "--csv" in a:
        csvdir = a[a.index("--csv") + 1]
    with Office() as office:
        t0 = time.time()
        doc = office.load(src)
        t1 = time.time()
        if edit:
            set_cell(doc, *edit)
        doc.calculateAll()
        t2 = time.time()
        sheets = dump(doc)
        doc.close(True)
    res = {"openMs": round((t1 - t0) * 1000), "calcMs": round((t2 - t1) * 1000), "sheets": sheets}
    with open(dst, "w") as f:
        json.dump(res, f)
    if csvdir:
        os.makedirs(csvdir, exist_ok=True)
        for name, cells in sheets.items():
            grid = {}
            for ref, (k, v, s) in cells.items():
                col = "".join(ch for ch in ref if ch.isalpha())
                grid.setdefault(int(ref[len(col):]), {})[col] = s if s is not None else v
            with open(os.path.join(csvdir, name.replace("/", "_") + ".csv"), "w", newline="") as f:
                w = csv.writer(f)
                for r in sorted(grid):
                    row = grid[r]
                    w.writerow([r] + [f"{c}={row[c]}" for c in row])


if __name__ == "__main__":
    main()
