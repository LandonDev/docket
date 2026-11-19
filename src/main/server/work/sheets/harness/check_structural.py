"""A structural edit, judged (milestone 27): the patch writer's output after LibreOffice inserted one
row, against LibreOffice inserting the same row into the original.

    python -I check_structural.py <orig.xlsx> <out.xlsx> SHEET ROW0 [col]

With `col`, the edit was a column inserted before column ROW0. Cells where LibreOffice's reopened view
of our file disagrees with what our file stores (it lays out again a pivot table it wrote) are left
out, as the lab's reopen check leaves them out of the original (reopen.oracle_noise).

Prints one JSON line: V (cells whose recalculated value differs, either side), a few examples, and the
features xmldiff counts by number, not by position, that are lost (KEPT below).
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reopen, xmldiff  # noqa: E402

orig, out, sheet, row = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
flag = "--insert-col" if len(sys.argv) > 5 and sys.argv[5] == "col" else "--insert-row"
cmd_want = out + ".want.json"
p = __import__("subprocess").run([reopen.LOPY, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lo_dump.py"), orig, cmd_want, flag, sheet, row], capture_output=True, text=True, timeout=2400)
if p.returncode != 0:
    raise RuntimeError("lo_dump failed: " + (p.stderr or p.stdout)[-600:])
want = json.load(open(cmd_want))["sheets"]
got_dump = reopen.lo_dump(out, out + ".got.json")
got = got_dump["sheets"]
out_ext = xmldiff.extract(out)
noise = reopen.oracle_noise(out_ext, got_dump)
for f in (cmd_want, out + ".got.json"):
    os.remove(f)
diffs = []
for name in set(want) | set(got):
    w, g = want.get(name, {}), got.get(name, {})
    for ref in set(w) | set(g):
        a = tuple(w[ref][:2]) if ref in w else None
        b = tuple(g[ref][:2]) if ref in g else None
        if f"{name}!{ref}" in noise:
            continue
        if not reopen.same(a, b) and not (a and b and a[0] == "e" and b[0] == "e"):
            diffs.append(f"{name}!{ref}: LibreOffice {a}, ours {b}")
# Features xmldiff counts without their cell positions (a moved merge or comment reads to it as another one).
KEPT = {"sheets", "chartsheets", "vbaProject.bin byte-identical", "VBA macro source (olevba)", "metadata.xml (dynamic arrays)", "charts (chart parts)",
        "chart series", "chart types", "tables", "pivot tables", "pivot caches", "images in drawings", "media files (byte-identical)",
        "shapes/text boxes/buttons in drawings", "sparklines", "external links", "data validations by type", "conditional formats: rules by type",
        "persons (threaded comment authors)", "workbook content type"}
feats = xmldiff.compare(xmldiff.extract(orig), out_ext, None, []).get("features", [])
lost = [x["feature"] for x in feats if x["status"] == "lost" and x["feature"] in KEPT]
print(json.dumps({"V": len(diffs), "examples": sorted(diffs)[:8], "lost": lost, "noise": len(noise)}))
