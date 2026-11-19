"""Reopen check: recalculate the round-tripped file in headless LibreOffice and
compare its values with the original's, edited the same way by LibreOffice.

    /tmp/sheetlab/tools/py/bin/python -I reopen.py <orig.xlsx> <roundtrip.xlsx> SHEET A1 VALUE [--json out.json] [--csv DIR]

The oracle is LibreOffice on both sides: expected = LO(original + same edit),
actual = LO(round-trip). Cells where LO(original) and LO(original + edit)
differ are the edit's dependents; they are expected to change. Any other
difference is a value the engine lost or changed. Also checks the round-trip's
own cached <v> values against the expected values (stale caches after the edit).
"""
import hashlib, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOPY = os.environ.get("SHEETLAB_LOPY", "/tmp/sheetlab/tools/lo/opt/libreoffice26.8/program/python")
REF_DIR = os.environ.get("SHEETLAB_REF", os.path.join(HERE, "..", "results", "_reference"))


def lo_dump(path, out, edit=None, timeout=1200, csvdir=None):
    cmd = [LOPY, os.path.join(HERE, "lo_dump.py"), path, out]
    if edit:
        cmd += ["--edit", *edit]
    if csvdir:
        cmd += ["--csv", csvdir]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0 or not os.path.exists(out):
        raise RuntimeError("lo_dump failed: " + (p.stderr or p.stdout)[-600:])
    return json.load(open(out))


def same(a, b):
    if a is None or b is None:
        return a is b
    if a[0] == "n" and b[0] == "n":
        return abs(a[1] - b[1]) <= 1e-9 * max(1.0, abs(a[1]))
    return a[0] == b[0] and a[1] == b[1]


def reference(orig, edit, timeout=1200):
    """LO dumps of the original and of the original with the edit, cached by content hash."""
    h = hashlib.sha1(open(orig, "rb").read()).hexdigest()[:16]
    key = f"{os.path.basename(orig)}-{h}-{'_'.join(edit)}".replace("/", "_")
    os.makedirs(REF_DIR, exist_ok=True)
    po, pe = os.path.join(REF_DIR, key + ".orig.json"), os.path.join(REF_DIR, key + ".edited.json")
    o = json.load(open(po)) if os.path.exists(po) else lo_dump(orig, po, timeout=timeout,
                                                                csvdir=os.path.join(REF_DIR, key + ".orig.csv"))
    e = json.load(open(pe)) if os.path.exists(pe) else lo_dump(orig, pe, edit, timeout=timeout,
                                                                csvdir=os.path.join(REF_DIR, key + ".edited.csv"))
    deps = []
    for sheet, cells in e["sheets"].items():
        oc = o["sheets"].get(sheet, {})
        for ref in set(cells) | set(oc):
            if not same(tuple(cells[ref][:2]) if ref in cells else None, tuple(oc[ref][:2]) if ref in oc else None):
                deps.append(f"{sheet}!{ref}")
    return o, e, sorted(deps)


def oracle_noise(orig_extract, orig_dump):
    """Cells where LibreOffice's own render of the original disagrees with the values stored in it
    (e.g. LO re-lays out a pivot it wrote). Differences there say nothing about the engine."""
    noise = set()
    for sheet, sh in orig_extract["sheets"].items():
        dc = orig_dump["sheets"].get(sheet, {})
        stored = dict(sh["values"]); stored.update({k: v for k, v in sh["cached"].items() if v is not None})
        for ref in set(stored) | set(dc):
            sv, dv = stored.get(ref), dc.get(ref)
            dv = tuple(dv[:2]) if dv else None
            if sv is not None and sv[0] == "e" and dv is not None and dv[0] == "e":
                continue
            if sv is None and dv is not None and dv[0] == "s" and dv[1] == "":
                continue
            if not same(sv, dv):
                noise.add(f"{sheet}!{ref}")
    return noise


def compare_dumps(expected, actual, edit, deps, limit=25, noise=()):
    deps = set(deps)
    noise = set(noise) - deps
    res = {"cells": 0, "value_diffs": 0, "missing": 0, "extra": 0, "shown_diffs": 0, "missing_sheets": [],
           "extra_sheets": [], "examples": [], "shown_examples": [], "dependents": len(deps), "oracle_noise": len(noise)}
    for sheet, cells in expected["sheets"].items():
        ac = actual["sheets"].get(sheet)
        if ac is None:
            res["missing_sheets"].append(sheet)
            res["missing"] += len(cells)
            continue
        for ref, ev in cells.items():
            if f"{sheet}!{ref}" in noise:
                continue
            res["cells"] += 1
            av = ac.get(ref)
            if av is None:
                res["missing"] += 1
                if len(res["examples"]) < limit:
                    res["examples"].append(f"{sheet}!{ref}: expected {ev[1]!r}, got empty" + (" (dependent)" if f"{sheet}!{ref}" in deps else ""))
                continue
            if not same(tuple(ev[:2]), tuple(av[:2])):
                res["value_diffs"] += 1
                if len(res["examples"]) < limit:
                    res["examples"].append(f"{sheet}!{ref}: expected {ev[1]!r}, got {av[1]!r}" + (" (dependent)" if f"{sheet}!{ref}" in deps else ""))
            elif ev[2] is not None and av[2] is not None and ev[2] != av[2]:
                res["shown_diffs"] += 1
                if len(res["shown_examples"]) < limit:
                    res["shown_examples"].append(f"{sheet}!{ref}: expected shown {ev[2]!r}, got {av[2]!r}")
        for ref in ac:
            if ref not in cells:
                res["extra"] += 1
    res["extra_sheets"] = [s for s in actual["sheets"] if s not in expected["sheets"]]
    return res


def stale_cache(rt_extract, expected, deps):
    """Round-trip's own cached formula values vs LO's recalculated expected values."""
    deps = set(deps)
    out = {"formulas": 0, "match": 0, "stale_dependents": 0, "other_mismatch": 0, "no_cache": 0, "examples": []}
    for sheet, sh in rt_extract["sheets"].items():
        ev = expected["sheets"].get(sheet, {})
        for ref, cv in sh["cached"].items():
            out["formulas"] += 1
            e = ev.get(ref)
            e = tuple(e[:2]) if e else None
            if cv is None:
                out["no_cache"] += 1
            elif e is not None and (same(cv, e) or (cv[0] == "e" and e[0] == "e")):
                out["match"] += 1
            elif f"{sheet}!{ref}" in deps:
                out["stale_dependents"] += 1
                if len(out["examples"]) < 10:
                    out["examples"].append(f"{sheet}!{ref}: cached {cv[1]!r}, recalculated {e[1] if e else None!r}")
            else:
                out["other_mismatch"] += 1
    return out


def main():
    a = sys.argv[1:]
    orig, rt, sheet, cell, value = a[:5]
    edit = (sheet, cell, value)
    o_dump, expected, deps = reference(orig, edit)
    tmp = rt + ".lo.json"
    actual = lo_dump(rt, tmp, csvdir=a[a.index("--csv") + 1] if "--csv" in a else None)
    sys.path.insert(0, HERE)
    import xmldiff
    res = compare_dumps(expected, actual, edit, deps, noise=oracle_noise(xmldiff.extract(orig), o_dump))
    res["openMs"] = actual["openMs"]
    res["cache"] = stale_cache(xmldiff.extract(rt), expected, deps)
    if "--json" in a:
        json.dump(res, open(a[a.index("--json") + 1], "w"), indent=1)
    else:
        print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
