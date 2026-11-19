"""One round trip, judged as the sheet research's lab judged it (reports/nJLC5WoplSWf, lab/scripts/runner.py).

    python -I check.py <orig.xlsx> <roundtrip.xlsx> SHEET A1 VALUE

Prints one JSON line: L (features lost), C (features changed), V (values that differ on reopen,
outside the edit and its dependents), the features named, and the stale cached values.
xmldiff.py, ooxml.py, reopen.py and lo_dump.py beside it are the lab's, unchanged. Needs lxml,
and LibreOffice's own python in SHEETLAB_LOPY for the reopen check.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reopen, xmldiff  # noqa: E402

orig, rt, *edit = sys.argv[1:]
edit = tuple(edit)
o_dump, expected, deps = reopen.reference(orig, edit)
o_ext, r_ext = xmldiff.extract(orig), xmldiff.extract(rt)
diff = xmldiff.compare(o_ext, r_ext, edit, deps)
actual = reopen.lo_dump(rt, rt + ".lo.json")
os.remove(rt + ".lo.json")
v = reopen.compare_dumps(expected, actual, edit, deps, noise=reopen.oracle_noise(o_ext, o_dump))
cache = reopen.stale_cache(r_ext, expected, deps)
feats = diff.get("features", [])
print(json.dumps({
    "L": sum(1 for x in feats if x["status"] == "lost"),
    "C": sum(1 for x in feats if x["status"] == "changed"),
    "V": v.get("value_diffs", 0) + v.get("missing", 0),
    "bad": [x["feature"] for x in feats if x["status"] in ("lost", "changed")],
    "stale": cache.get("stale_dependents", 0) if cache else 0,
}))
