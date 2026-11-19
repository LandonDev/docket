"""Batch check: LibreOffice recalculates a patched file and every cached formula value in it is compared.

    python -I batch.py <patched.xlsx>

Prints one JSON line: formulas, match, mismatch and a few examples. The lab's
adapters/patch/scripts/check_batch.py, pointed at the harness beside it.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reopen, xmldiff  # noqa: E402

p = sys.argv[1]
d = reopen.lo_dump(p, p + ".lo.json", timeout=2400)
ext = xmldiff.extract(p)
out = {"formulas": 0, "match": 0, "mismatch": 0, "examples": []}
for sheet, sh in ext["sheets"].items():
    lo = d["sheets"].get(sheet, {})
    for ref, cv in sh["cached"].items():
        out["formulas"] += 1
        e = lo.get(ref)
        e = tuple(e[:2]) if e else None
        if cv is not None and e is not None and (reopen.same(cv, e) or (cv[0] == "e" and e[0] == "e")):
            out["match"] += 1
        else:
            out["mismatch"] += 1
            if len(out["examples"]) < 8:
                out["examples"].append(f"{sheet}!{ref}: stored {cv}, LibreOffice {e}")
os.remove(p + ".lo.json")
print(json.dumps(out))
