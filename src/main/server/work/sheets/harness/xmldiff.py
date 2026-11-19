"""Compare an original .xlsx with a round-tripped one, part by part and feature by feature.

    /tmp/sheetlab/tools/py/bin/python -I xmldiff.py <orig.xlsx> <roundtrip.xlsx> [--edit SHEET!A1=VALUE]
        [--dependents deps.json] [--json out.json] [--md out.md]

Reports: parts added/removed; per common part whether the canonical XML (C14N,
blank text dropped) is identical; and per feature what survived (formulas and
their text, cached values, plain values, per-cell style, conditional formats by
type, data validations, defined names, tables, charts and series, pivots,
external links, VBA bytes, notes and threaded comments, merged cells, images,
panes, column widths, hidden rows, hyperlinks, protection, print setup ...).
"""
import collections, hashlib, json, re, sys, zipfile

from lxml import etree

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from ooxml import NS, parse, read_rels, sheet_parts, workbook_part, split_ref, col_name  # noqa: E402

M = "{%s}" % NS["m"]
R_ID = "{%s}id" % NS["r"]
BUILTIN_FMT = {0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
               12: "# ?/?", 13: "# ??/??", 14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM",
               19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm", 37: "#,##0 ;(#,##0)",
               38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss",
               46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@"}


def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def c14n_hash(data):
    try:
        root = parse(data)
        for el in root.iter():
            if el.text is not None and not el.text.strip():
                el.text = None
            if el.tail is not None and not el.tail.strip():
                el.tail = None
        return hashlib.sha1(etree.tostring(root, method="c14n")).hexdigest()
    except Exception:
        return hashlib.sha1(data).hexdigest()


# ------------------------------------------------------------------ styles
try:
    from openpyxl.styles.colors import COLOR_INDEX  # the legacy 64-colour indexed palette
except ImportError:
    COLOR_INDEX = []


def color_sig(el):
    if el is None:
        return ""
    idx = el.get("indexed")
    if idx is not None and idx.isdigit() and int(idx) < 64 and int(idx) < len(COLOR_INDEX) and el.get("tint") is None:
        return "rgb=" + COLOR_INDEX[int(idx)][-6:].upper()  # indexed 5 and rgb FFFFFF00 are the same yellow
    if idx in ("64", "65") or (el.get("rgb") is None and el.get("theme") is None and idx is None):
        return ""  # system foreground/background, i.e. automatic
    sig = ",".join(f"{k}={el.get(k)[-6:].upper() if k == 'rgb' else el.get(k)}"  # alpha byte ignored
                   for k in ("rgb", "theme", "indexed", "tint") if el.get(k) is not None)
    return sig


def norm_numfmt(code):
    """Spelling-insensitive number format: drop quotes/escapes, case, and order of [..] tokens per section."""
    out = []
    for sec in (code or "").replace("\\", "").replace('"', "").lower().split(";"):
        tokens = re.findall(r"^((?:\[[^\]]*\])*)(.*)$", sec)[0]
        out.append("".join(sorted(re.findall(r"\[[^\]]*\]", tokens[0]))) + tokens[1])
    return ";".join(out)


def load_styles(z, wb):
    rels = read_rels(z, wb)
    part = next((t for (ty, t, e) in rels.values() if ty == "styles"), None)
    info = {"counts": {}, "xf": []}
    if not part or part not in z.namelist():
        return info
    root = parse(z.read(part))
    fmts = dict(BUILTIN_FMT)
    nf = root.find(M + "numFmts")
    if nf is not None:
        for f in nf:
            fmts[int(f.get("numFmtId"))] = f.get("formatCode")

    def kids(name):
        el = root.find(M + name)
        return list(el) if el is not None else []

    fonts = []
    for f in kids("fonts"):
        d = {}
        for ch in f:
            n = local(ch.tag)
            d[n] = nb(ch.get("val", "1")) if n != "color" else color_sig(ch)
            if n == "color" and d[n] in ("theme=1", "rgb=000000", ""):
                del d[n]  # dark text 1 / black / automatic are the default font colour
            if n == "u" and d[n] == "1":
                d[n] = "single"
            if n == "sz":
                try:
                    d[n] = f"{float(d[n]):g}"
                except ValueError:
                    pass
            if n in ("b", "i", "strike", "outline", "shadow", "condense", "extend") and d[n] == "0":
                del d[n]  # explicit "off" equals absent
            if n in ("u", "vertAlign") and d.get(n) in ("none", "baseline"):
                del d[n]
        fonts.append(";".join(f"{k}={d[k]}" for k in sorted(d) if k not in ("family", "scheme", "charset")))
    fills = []
    for f in kids("fills"):
        pf = f.find(M + "patternFill")
        if pf is not None:
            pt = pf.get("patternType", "none")
            bg = "" if pt == "solid" else color_sig(pf.find(M + "bgColor"))  # solid fills ignore bgColor
            fills.append("none" if pt == "none" else f"{pt}:{color_sig(pf.find(M + 'fgColor'))}/{bg}")
        else:
            fills.append("gradient")
    borders = []
    for b in kids("borders"):
        parts = []
        for side in ("left", "right", "top", "bottom", "diagonal"):
            s = b.find(M + side)
            if s is not None and s.get("style") and s.get("style") != "none":
                bc = color_sig(s.find(M + "color"))
                parts.append(f"{side}:{s.get('style')}:{'' if bc in ('rgb=000000', 'theme=1') else bc}")
        borders.append(",".join(parts))
    for x in kids("cellXfs"):
        nfid = int(x.get("numFmtId", 0))
        fi, fl, bo = int(x.get("fontId", 0)), int(x.get("fillId", 0)), int(x.get("borderId", 0))
        al = x.find(M + "alignment")
        pr = x.find(M + "protection")
        alsig = ",".join(f"{k}={nb(v)}" for k, v in sorted(al.attrib.items()) if v not in ("false", "0", "general", "bottom")) if al is not None else ""
        prsig = ",".join(f"{k}={nb(v)}" for k, v in sorted(pr.attrib.items())
                         if (k, nb(v)) not in (("locked", "1"), ("hidden", "0"))) if pr is not None else ""
        info["xf"].append({
            "numFmt": norm_numfmt(fmts.get(nfid, f"id{nfid}")),
            "font": fonts[fi] if fi < len(fonts) else "",
            "fill": fills[fl] if fl < len(fills) else "",
            "border": borders[bo] if bo < len(borders) else "",
            "align": alsig, "protect": prsig,
        })
    for name in ("numFmts", "fonts", "fills", "borders", "cellXfs", "cellStyleXfs", "cellStyles", "dxfs"):
        info["counts"][name] = len(kids(name))
    return info


# ------------------------------------------------------------------ sheets
def shared_strings(z, wb):
    rels = read_rels(z, wb)
    part = next((t for (ty, t, e) in rels.values() if ty == "sharedStrings"), None)
    if not part or part not in z.namelist():
        return []
    out = []
    for _, si in etree.iterparse(z.open(part), tag=M + "si", huge_tree=True):
        out.append("".join(t.text or "" for t in si.iter(M + "t") if local(t.getparent().tag) != "rPh"))
        si.clear()
    return out


class Translator:
    """Shared-formula expansion via openpyxl's translator, cached per (si, offset)."""
    def __init__(self):
        from openpyxl.formula.translate import Translator as T
        self.T = T

    def __call__(self, text, origin, target):
        try:
            return self.T("=" + text, origin=origin).translate_formula(target)[1:]
        except Exception:
            return text


def read_sheet(z, part, sst, xfs, trans):
    s = {"values": {}, "formulas": {}, "cached": {}, "style": {}, "array": 0, "dynamic": 0, "shared": 0}
    shared = {}
    ctx = etree.iterparse(z.open(part), events=("start", "end"), huge_tree=True)
    root = None
    hidden_rows, heights, outline = [], {}, 0
    for ev, el in ctx:
        if root is None:
            root = el
        if ev != "end":
            continue
        tag = el.tag
        if tag == M + "c":
            ref = el.get("r")
            t = el.get("t", "n")
            v = el.find(M + "v")
            f = el.find(M + "f")
            val = None
            if t == "s" and v is not None:
                try:
                    val = ("s", sst[int(v.text)])
                except (ValueError, IndexError):
                    val = ("s", None)
            elif t == "inlineStr":
                val = ("s", "".join(x.text or "" for x in el.iter(M + "t")))
            elif t in ("str",):
                val = ("s", v.text if v is not None else "")
            elif t == "b":
                val = ("n", float(v.text) if v is not None and v.text else 0.0)
            elif t == "e":
                val = ("e", v.text if v is not None else None)
            elif v is not None and v.text is not None:
                try:
                    val = ("n", float(v.text))
                except ValueError:
                    val = ("s", v.text)
            si = int(el.get("s", 0))
            if 0 < si < len(xfs) or (si == 0 and xfs):
                xf = xfs[si] if si < len(xfs) else {}
                s["style"][ref] = "|".join(f"{k}:{xf.get(k, '')}" for k in ("numFmt", "font", "fill", "border", "align", "protect"))
            if f is not None:
                ft = f.get("t")
                text = f.text or ""
                if ft == "shared":
                    s["shared"] += 1
                    idx = f.get("si")
                    if text:
                        shared[idx] = (text, ref)
                    elif idx in shared:
                        base, origin = shared[idx]
                        text = trans(base, origin, ref)
                if ft == "array":
                    s["array"] += 1
                if el.get("cm") is not None:
                    s["dynamic"] += 1
                s["formulas"][ref] = text
                s["cached"][ref] = val
            elif val is not None:
                s["values"][ref] = val
            el.clear()
        elif tag == M + "row":
            if el.get("hidden") in ("1", "true"):
                hidden_rows.append(int(el.get("r")))
            if el.get("customHeight") in ("1", "true") and el.get("ht"):
                heights[int(el.get("r"))] = round(float(el.get("ht")), 1)
            if el.get("outlineLevel") not in (None, "0"):
                outline += 1
            el.clear()
    s["hidden_rows"] = hidden_rows
    s["row_heights"] = heights
    s["outline_rows"] = outline
    s["xml"] = root
    return s


def nb(v):
    """Normalise OOXML boolean spellings and hash case."""
    return {"true": "1", "false": "0"}.get(v, v.lower() if isinstance(v, str) and re.fullmatch(r"[0-9A-Fa-f]{4}", v) else v)


def sheet_extras(z, part, root):
    d = {}
    cols = {}
    for c in root.iter(M + "col"):
        lo, hi = int(c.get("min")), int(c.get("max"))
        for i in range(lo, min(hi, lo + 64) + 1):
            cols[i] = (round(float(c.get("width", 0)), 2) if c.get("customWidth") in ("1", "true") or c.get("width") else None,
                       c.get("hidden") in ("1", "true"))
    d["col_widths"] = {k: v[0] for k, v in cols.items() if v[0] is not None and not v[1]}  # a hidden column's width is moot
    d["hidden_cols"] = sorted(k for k, v in cols.items() if v[1])
    d["merged"] = sorted(m.get("ref") for m in root.iter(M + "mergeCell"))
    pane = root.find(f"{M}sheetViews/{M}sheetView/{M}pane")
    d["pane"] = {k: pane.get(k) for k in ("xSplit", "ySplit", "topLeftCell", "state")
                 if pane.get(k) and pane.get(k) != "0" and not (k == "state" and pane.get(k) == "split")} if pane is not None else None
    cf = collections.Counter()
    cf_ranges = 0
    for block in root.findall(M + "conditionalFormatting"):
        cf_ranges += 1
        for rule in block.findall(M + "cfRule"):
            t = rule.get("type")
            cf[t] += 1
    x14cf = collections.Counter()
    for rule in root.iter("{%s}cfRule" % NS["x14"]):
        x14cf[rule.get("type")] += 1
    d["cf_rules"] = dict(cf)
    d["cf_ranges"] = cf_ranges
    d["cf_x14_rules"] = dict(x14cf)
    dv = collections.Counter()
    for v in root.iter(M + "dataValidation"):
        dv[v.get("type", "none")] += 1
    for v in root.iter("{%s}dataValidation" % NS["x14"]):
        dv[v.get("type", "none")] += 1  # the x14 form (cross-sheet lists) counts as the same rule
    d["dv"] = dict(dv)
    d["hyperlinks"] = len(list(root.iter(M + "hyperlink")))
    prot = root.find(M + "sheetProtection")
    d["protection"] = {k: nb(v) for k, v in sorted(prot.attrib.items())} if prot is not None else None
    ps = root.find(M + "pageSetup")
    defaults = {"orientation": ("default", "portrait"), "paperSize": ("1",), "fitToWidth": ("1",), "fitToHeight": ("1",),
                "scale": ("100",), "firstPageNumber": ("1",)}
    d["page_setup"] = {k: ps.get(k) for k in defaults if ps.get(k) and ps.get(k) not in defaults[k]
                       and (k != "firstPageNumber" or ps.get("useFirstPageNumber") in ("1", "true"))} if ps is not None else None
    d["page_setup"] = d["page_setup"] or None
    fit = root.find(f"{M}sheetPr/{M}pageSetUpPr")
    if fit is not None and fit.get("fitToPage") in ("1", "true"):
        d["page_setup"] = dict(d["page_setup"] or {}, fitToPage="1")
    po = root.find(M + "printOptions")
    d["print_options"] = ({k: "1" for k, v in po.attrib.items() if v in ("1", "true") and k != "gridLinesSet"} or None) if po is not None else None
    hf = root.find(M + "headerFooter")
    d["header_footer"] = [(local(e.tag), e.text) for e in hf] if hf is not None else []
    d["row_breaks"] = len(list(root.iter(M + "brk")))
    af = root.find(M + "autoFilter")
    d["autofilter"] = af.get("ref") if af is not None else None
    d["sparklines"] = len(list(root.iter("{http://schemas.microsoft.com/office/spreadsheetml/2009/9/main}sparkline")))
    sv = root.find(f"{M}sheetViews/{M}sheetView")
    d["view"] = {k: nb(sv.get(k)) for k in ("zoomScale", "showGridLines")
                 if sv is not None and nb(sv.get(k)) not in (None, "100", "1")}
    tab = root.find(f"{M}sheetPr/{M}tabColor")
    d["tab_color"] = color_sig(tab) if tab is not None else None
    # related parts
    rels = read_rels(z, part)
    d["tables"], d["comments"], d["threaded"], d["images"], d["charts"], d["shapes"], d["pivots"] = [], 0, 0, 0, 0, 0, []
    for rid, (ty, tgt, ext) in rels.items():
        if tgt not in z.namelist():
            continue
        if ty == "table":
            t = parse(z.read(tgt))
            d["tables"].append({"name": t.get("displayName") or t.get("name"), "ref": t.get("ref"),
                                "columns": len(t.findall(f"{M}tableColumns/{M}tableColumn")),
                                "calculated": len(list(t.iter(M + "calculatedColumnFormula"))),
                                "totals": t.get("totalsRowCount") or "0",
                                "style": (t.find(M + "tableStyleInfo").get("name") if t.find(M + "tableStyleInfo") is not None else None)})
        elif ty == "comments":
            d["comments"] += len(list(parse(z.read(tgt)).iter(M + "comment")))
        elif ty == "threadedComment":
            d["threaded"] += len(list(parse(z.read(tgt)).iter("{%s}threadedComment" % NS["tc"])))
        elif ty == "drawing":
            dr = parse(z.read(tgt))
            d["images"] += len(list(dr.iter("{%s}pic" % NS["xdr"])))
            d["shapes"] += len(list(dr.iter("{%s}sp" % NS["xdr"])))
            d["charts"] += sum(1 for e in dr.iter() if local(e.tag) == "chart")
        elif ty == "pivotTable":
            p = parse(z.read(tgt))
            d["pivots"].append({"name": p.get("name"),
                                "fields": len(p.findall(f"{M}pivotFields/{M}pivotField")),
                                "rowFields": len(p.findall(f"{M}rowFields/{M}field")),
                                "colFields": len(p.findall(f"{M}colFields/{M}field")),
                                "pageFields": len(p.findall(f"{M}pageFields/{M}pageField")),
                                "dataFields": len(p.findall(f"{M}dataFields/{M}dataField"))})
    d["legacy_vml"] = any(ty == "vmlDrawing" for ty, _, _ in rels.values())
    return d


def vba_sources(data):
    """{module: normalised source} for modules with code (oletools' olevba; {} if not installed)."""
    try:
        from oletools.olevba import VBA_Parser
    except ImportError:
        return {"(oletools not installed)": ""}
    out = {}
    try:
        vp = VBA_Parser("vbaProject.bin", data=data)
        for _, _, name, code in vp.extract_macros():
            lines = [l.rstrip() for l in (code or "").replace("\r\n", "\n").split("\n")
                     if l.strip() and not l.startswith("Attribute VB_")]
            if lines:
                out[name.rsplit(".", 1)[0]] = "\n".join(lines)
    except Exception as e:
        out["(unreadable)"] = str(e)[:200]
    return out


# ------------------------------------------------------------------ package
def extract(path):
    z = zipfile.ZipFile(path)
    names = sorted(n for n in z.namelist() if not n.endswith("/"))
    wb = workbook_part(z)
    wbroot = parse(z.read(wb))
    styles = load_styles(z, wb)
    sst = shared_strings(z, wb)
    trans = Translator()
    sheets = {}
    states = {}
    for s in wbroot.iter(M + "sheet"):
        states[s.get("name")] = s.get("state", "visible")
    sheet_names = list(states)
    for name, part in sheet_parts(z).items():
        if part not in z.namelist():
            continue
        sh = read_sheet(z, part, sst, styles["xf"], trans)
        sh.update(sheet_extras(z, part, sh.pop("xml")))
        sheets[name] = sh
    names_ = []
    for dn in wbroot.iter(M + "definedName"):
        lid = dn.get("localSheetId")
        scope = sheet_names[int(lid)] if lid is not None and int(lid) < len(sheet_names) else None
        names_.append((dn.get("name"), scope, (dn.text or "").strip()))
    charts = []
    for n in names:
        if re.match(r"xl/charts/chart\d+\.xml$", n):
            root = parse(z.read(n))
            pa = root.find(f"{{{NS['c']}}}chart/{{{NS['c']}}}plotArea")
            types = [local(e.tag) for e in pa if local(e.tag).endswith("Chart")] if pa is not None else []
            charts.append({"part": n, "types": types, "series": len(list(root.iter(f"{{{NS['c']}}}ser")))})
        elif n.startswith("xl/charts/chartEx"):
            charts.append({"part": n, "types": ["chartEx"], "series": 0})
    pivot_caches = []
    for n in names:
        if re.match(r"xl/pivotCache/pivotCacheDefinition\d+\.xml$", n):
            root = parse(z.read(n))
            pivot_caches.append({"fields": len(root.findall(f"{M}cacheFields/{M}cacheField")),
                                 "records": root.get("recordCount")})
    ext_links = []
    for n in names:
        if re.match(r"xl/externalLinks/externalLink\d+\.xml$", n):
            rels = read_rels(z, n)
            root = parse(z.read(n))
            ext_links.append({"target": [t for (_, t, _) in rels.values()],
                              "cached_cells": len(list(root.iter(M + "cell")))})
    vba = hashlib.sha256(z.read("xl/vbaProject.bin")).hexdigest() if "xl/vbaProject.bin" in names else None
    vba_code = vba_sources(z.read("xl/vbaProject.bin")) if vba else {}
    media = sorted(hashlib.sha1(z.read(n)).hexdigest()[:12] for n in names if n.startswith("xl/media/"))
    ct = parse(z.read("[Content_Types].xml"))
    main_ct = next((o.get("ContentType") for o in ct if o.get("PartName") == "/" + wb), None)
    persons = sum(len(list(parse(z.read(n)).iter("{%s}person" % NS["tc"]))) for n in names if n.startswith("xl/persons/"))
    return {
        "parts": names, "part_hash": {n: c14n_hash(z.read(n)) if n.endswith((".xml", ".rels", ".vml")) else
                                       hashlib.sha1(z.read(n)).hexdigest() for n in names},
        "sheet_states": states, "sheets": sheets, "defined_names": names_, "styles": styles["counts"],
        "charts": charts, "chartsheets": sum(1 for n in names if n.startswith("xl/chartsheets/sheet")),
        "pivot_caches": pivot_caches, "external_links": ext_links, "vba": vba, "media": media,
        "main_content_type": main_ct, "persons": persons, "vba_code": vba_code,
        "workbook_protection": {k: v for k, v in (wbroot.find(M + "workbookProtection").attrib.items()
                                if wbroot.find(M + "workbookProtection") is not None else []) if v not in ("0", "false")},
        "metadata_part": "xl/metadata.xml" in names,
    }


# ------------------------------------------------------------------ compare
def norm_formula(f):
    out, in_str = [], False
    for ch in f or "":
        if ch == '"':
            in_str = not in_str
        if not in_str and ch.isspace():
            continue
        out.append(ch if in_str else ch.upper())
    s = "".join(out)
    return s[1:] if s.startswith("=") else s


def strip_prefix(f):
    return re.sub(r"_XL(FN|WS|PM)\.", "", f)


def same_val(a, b):
    if a is None or b is None:
        return a == b
    if a[0] == "n" and b[0] == "n":
        return abs(a[1] - b[1]) <= 1e-9 * max(1.0, abs(a[1]))
    return a == b


def status(o, r):
    if o == r:
        return "kept"
    if isinstance(o, (int, float)) and isinstance(r, (int, float)):
        if o and not r:
            return "lost"
        if not o and r:
            return "added"
    if o and not r:
        return "lost"
    if not o and r:
        return "added"
    return "changed"


def counter_kept(o, r):
    """Multiset overlap of two {key: count} dicts."""
    return sum(min(v, r.get(k, 0)) for k, v in o.items())


def compare(o, r, edit=None, dependents=()):
    rows = []

    def row(feature, ov, rv, st=None, detail=None):
        rows.append({"feature": feature, "orig": ov, "rt": rv, "status": st or status(ov, rv),
                     **({"detail": detail} if detail else {})})

    edit_sheet, edit_cell = (edit[0], edit[1]) if edit else (None, None)
    deps = set(dependents)  # "Sheet!A1" cells whose value the edit changes (from the reopen oracle)
    op, rp = set(o["parts"]), set(r["parts"])
    removed, added = sorted(op - rp), sorted(rp - op)
    common = sorted(op & rp)
    identical = [p for p in common if o["part_hash"][p] == r["part_hash"][p]]
    parts = {"removed": removed, "added": added, "common": len(common), "identical": len(identical),
             "changed": [p for p in common if p not in identical]}
    row("sheets", list(o["sheet_states"]), list(r["sheet_states"]))
    row("sheet states (hidden)", {k: v for k, v in o["sheet_states"].items() if v != "visible"},
        {k: v for k, v in r["sheet_states"].items() if v != "visible"})

    agg = collections.Counter()
    formula_examples = []
    style_examples = []
    for name, os_ in o["sheets"].items():
        rs = r["sheets"].get(name)
        if rs is None:
            agg["sheets_missing"] += 1
            agg["formulas"] += len(os_["formulas"])
            agg["values"] += len(os_["values"])
            continue
        for ref, ftext in os_["formulas"].items():
            agg["formulas"] += 1
            rt = rs["formulas"].get(ref)
            if rt is None:
                agg["formula_missing"] += 1
                if len(formula_examples) < 8:
                    formula_examples.append(f"{name}!{ref}: '{ftext}' -> (no formula, value {rs['values'].get(ref)})")
                continue
            if rt == ftext:
                agg["formula_exact"] += 1
            else:
                no, nr = norm_formula(ftext), norm_formula(rt)
                if no == nr:
                    agg["formula_norm"] += 1
                elif strip_prefix(no) == strip_prefix(nr):
                    agg["formula_prefix_only"] += 1
                else:
                    agg["formula_changed"] += 1
                    if len(formula_examples) < 8:
                        formula_examples.append(f"{name}!{ref}: '{ftext}' -> '{rt}'")
            if f"{name}!{ref}" in deps:
                agg["cached_dependent"] += 1
            elif same_val(os_["cached"].get(ref), rs["cached"].get(ref)):
                agg["cached_same"] += 1
            elif rs["cached"].get(ref) is None:
                agg["cached_missing"] += 1
        agg["rt_formulas"] += len(rs["formulas"])
        for ref, v in os_["values"].items():
            if (name == edit_sheet and ref == edit_cell) or f"{name}!{ref}" in deps:
                continue
            agg["values"] += 1
            rv = rs["values"].get(ref)
            if rv is None and ref in rs["cached"]:
                rv = rs["cached"][ref]
            if same_val(v, rv):
                agg["values_same"] += 1
        for ref, sig in os_["style"].items():
            agg["styled_cells"] += 1
            if rs["style"].get(ref) == sig:
                agg["style_same"] += 1
            elif len(style_examples) < 6:
                rsig = rs["style"].get(ref) or ""
                diff = [f"{a} -> {b}" for a, b in zip(sig.split("|"), rsig.split("|") or [""] * 6) if a != b]
                style_examples.append(f"{name}!{ref}: " + "; ".join(diff))
        agg["array"] += os_["array"]; agg["rt_array"] += rs["array"]
        agg["dynamic"] += os_["dynamic"]; agg["rt_dynamic"] += rs["dynamic"]
    sheet_pairs = [(n, s, r["sheets"].get(n)) for n, s in o["sheets"].items()]
    if edit:
        rs = r["sheets"].get(edit_sheet, {})
        got = (rs.get("values") or {}).get(edit_cell)
        want = edit[2]
        try:
            want_v = ("n", float(want))
        except ValueError:
            want_v = ("s", want)
        row("edit applied", f"{edit_sheet}!{edit_cell}={want}", got, "kept" if same_val(want_v, got) else "lost")
    f_kept = agg["formula_exact"] + agg["formula_norm"]
    row("formulas present", agg["formulas"], agg["formulas"] - agg["formula_missing"] - (0 if not agg["sheets_missing"] else 0),
        "kept" if agg["formula_missing"] == 0 else ("lost" if agg["formula_missing"] == agg["formulas"] else "changed"))
    row("formula text unchanged (exact)", agg["formulas"], agg["formula_exact"],
        "kept" if agg["formula_exact"] == agg["formulas"] else "changed")
    row("formula text unchanged (whitespace/case)", agg["formulas"], f_kept, "kept" if f_kept == agg["formulas"] else "changed",
        detail={"only _xlfn/_xlws/_xlpm prefix differs": agg["formula_prefix_only"], "rewritten": agg["formula_changed"],
                "examples": formula_examples})
    row("array formulas (t=array)", agg["array"], agg["rt_array"])
    row("dynamic-array cells (cm=)", agg["dynamic"], agg["rt_dynamic"])
    row("metadata.xml (dynamic arrays)", o["metadata_part"], r["metadata_part"])
    row("cached values unchanged (minus edit dependents)", agg["formulas"] - agg["cached_dependent"], agg["cached_same"],
        "kept" if agg["cached_same"] == agg["formulas"] - agg["cached_dependent"] else "changed",
        detail={"missing in rt": agg["cached_missing"], "dependents skipped": agg["cached_dependent"]})
    row("plain values unchanged (minus edit cell)", agg["values"], agg["values_same"],
        "kept" if agg["values_same"] == agg["values"] else "changed")
    row("cell style (numFmt/font/fill/border/align) unchanged", agg["styled_cells"], agg["style_same"],
        "kept" if agg["style_same"] == agg["styled_cells"] else "changed", detail={"examples": style_examples})
    for k in ("numFmts", "fonts", "fills", "borders", "cellXfs", "dxfs"):
        row(f"styles.xml {k} count", o["styles"].get(k, 0), r["styles"].get(k, 0), "info")

    def per_sheet(key, fn=len):
        ov = sum(fn(s.get(key) or 0) if not isinstance(s.get(key), (int, bool)) else int(s.get(key)) for _, s, _ in sheet_pairs)
        rv = sum((fn(rs.get(key) or 0) if not isinstance(rs.get(key), (int, bool)) else int(rs.get(key))) if rs else 0
                 for _, _, rs in sheet_pairs)
        return ov, rv

    def set_overlap(key):
        tot = kept = 0
        for _, s, rs in sheet_pairs:
            ov = s.get(key) or []
            rv = set((rs or {}).get(key) or [])
            tot += len(ov); kept += sum(1 for x in ov if x in rv)
        return tot, kept

    def dict_overlap(key):
        tot = kept = 0
        for _, s, rs in sheet_pairs:
            ov = s.get(key) or {}
            rv = (rs or {}).get(key) or {}
            tot += len(ov); kept += sum(1 for k, v in ov.items() if rv.get(k) == v)
        return tot, kept

    def counter_row(label, key):
        ot = collections.Counter(); rt = collections.Counter(); kept = 0
        for _, s, rs in sheet_pairs:
            oc, rc = s.get(key) or {}, (rs or {}).get(key) or {}
            ot.update(oc); rt.update(rc); kept += counter_kept(oc, rc)
        tot = sum(ot.values())
        st = ("kept" if sum(rt.values()) == tot else "added") if kept == tot else ("lost" if tot and not kept else "changed")
        row(label, dict(ot), dict(rt), st)

    t, k = set_overlap("merged"); row("merged cells", t, k, "kept" if t == k else ("lost" if t and not k else "changed"))
    counter_row("conditional formats: rules by type", "cf_rules")
    counter_row("conditional formats: x14 extension rules", "cf_x14_rules")
    ov, rv = per_sheet("cf_ranges"); row("conditional formats: ranges (blocks)", ov, rv)
    counter_row("data validations by type", "dv")
    t, k = dict_overlap("col_widths")
    cw = [f"{n}: {col_name(c - 1)} {w} -> {((rs or {}).get('col_widths') or {}).get(c)}" for n, s_, rs in sheet_pairs
          for c, w in (s_.get("col_widths") or {}).items() if ((rs or {}).get("col_widths") or {}).get(c) != w][:8]
    row("column widths", t, k, "kept" if t == k else ("lost" if t and not k else "changed"), detail={"examples": cw} if cw else None)
    t, k = set_overlap("hidden_cols"); row("hidden columns", t, k, "kept" if t == k else ("lost" if t and not k else "changed"))
    t, k = set_overlap("hidden_rows"); row("hidden rows", t, k, "kept" if t == k else ("lost" if t and not k else "changed"))
    t, k = dict_overlap("row_heights"); row("custom row heights", t, k, "kept" if t == k else ("lost" if t and not k else "changed"))
    ov, rv = per_sheet("outline_rows"); row("outline (grouped) rows", ov, rv)
    row("freeze/split panes", {n: s["pane"] for n, s, _ in sheet_pairs if s.get("pane")},
        {n: (rs or {}).get("pane") for n, s, rs in sheet_pairs if s.get("pane")})
    ov, rv = per_sheet("hyperlinks"); row("hyperlinks", ov, rv)
    ov, rv = per_sheet("comments"); row("notes (legacy comments)", ov, rv)
    ov, rv = per_sheet("threaded"); row("threaded comments", ov, rv)
    row("persons (threaded comment authors)", o["persons"], r["persons"])
    ov, rv = per_sheet("images"); row("images in drawings", ov, rv)
    row("media files (byte-identical)", len(o["media"]), len(set(o["media"]) & set(r["media"])),
        "kept" if set(o["media"]) <= set(r["media"]) else ("lost" if o["media"] and not set(o["media"]) & set(r["media"]) else "changed"))
    ov, rv = per_sheet("shapes"); row("shapes/text boxes/buttons in drawings", ov, rv)
    row("charts (chart parts)", len(o["charts"]), len(r["charts"]))
    row("chart types", sorted(t for c in o["charts"] for t in c["types"]), sorted(t for c in r["charts"] for t in c["types"]))
    row("chart series", sum(c["series"] for c in o["charts"]), sum(c["series"] for c in r["charts"]))
    row("chartsheets", o["chartsheets"], r["chartsheets"])
    ov, rv = per_sheet("sparklines"); row("sparklines", ov, rv)
    by_name = lambda xs: sorted(xs, key=lambda t: str(t.get("name")))
    row("tables", by_name([t for _, s, _ in sheet_pairs for t in s["tables"]]),
        by_name([t for _, _, rs in sheet_pairs for t in (rs or {}).get("tables", [])]))
    row("pivot tables", by_name([p for _, s, _ in sheet_pairs for p in s["pivots"]]),
        by_name([p for _, _, rs in sheet_pairs for p in (rs or {}).get("pivots", [])]))
    row("pivot caches", o["pivot_caches"], r["pivot_caches"])
    row("external links", o["external_links"], r["external_links"])
    row("defined names", len(o["defined_names"]), len(set(map(tuple, o["defined_names"])) & set(map(tuple, r["defined_names"]))),
        "kept" if set(map(tuple, o["defined_names"])) <= set(map(tuple, r["defined_names"])) else
        ("lost" if o["defined_names"] and not set(map(tuple, o["defined_names"])) & set(map(tuple, r["defined_names"])) else "changed"),
        detail={"missing": [list(x) for x in set(map(tuple, o["defined_names"])) - set(map(tuple, r["defined_names"]))][:12]})
    row("vbaProject.bin byte-identical", bool(o["vba"]), bool(r["vba"]) and r["vba"] == o["vba"],
        "kept" if o["vba"] == r["vba"] else ("lost" if o["vba"] else "added"))
    ok_mods = [m for m, c in o["vba_code"].items() if c and r["vba_code"].get(m) == c or c in r["vba_code"].values()]
    row("VBA macro source (olevba)", sorted(o["vba_code"]), sorted(m for m in o["vba_code"] if m in ok_mods),
        "kept" if len(ok_mods) == len(o["vba_code"]) else ("lost" if o["vba_code"] and not ok_mods else "changed"))
    row("workbook content type", o["main_content_type"], r["main_content_type"])
    row("sheet protection", {n: s["protection"] for n, s, _ in sheet_pairs if s["protection"]},
        {n: (rs or {}).get("protection") for n, s, rs in sheet_pairs if s["protection"]})
    row("workbook protection", o["workbook_protection"], r["workbook_protection"])
    row("page setup", {n: s["page_setup"] for n, s, _ in sheet_pairs if s["page_setup"]},
        {n: (rs or {}).get("page_setup") for n, s, rs in sheet_pairs if s["page_setup"]})
    row("print options", {n: s["print_options"] for n, s, _ in sheet_pairs if s["print_options"]},
        {n: (rs or {}).get("print_options") for n, s, rs in sheet_pairs if s["print_options"]})
    row("header/footer", {n: s["header_footer"] for n, s, _ in sheet_pairs if s["header_footer"]},
        {n: (rs or {}).get("header_footer") for n, s, rs in sheet_pairs if s["header_footer"]})
    ov, rv = per_sheet("row_breaks"); row("page breaks", ov, rv)
    row("autofilter", {n: s["autofilter"] for n, s, _ in sheet_pairs if s["autofilter"]},
        {n: (rs or {}).get("autofilter") for n, s, rs in sheet_pairs if s["autofilter"]})
    row("tab color", {n: s["tab_color"] for n, s, _ in sheet_pairs if s["tab_color"]},
        {n: (rs or {}).get("tab_color") for n, s, rs in sheet_pairs if s["tab_color"]})
    row("sheet view (zoom/gridlines)", {n: s["view"] for n, s, _ in sheet_pairs if any(s["view"].values())},
        {n: (rs or {}).get("view") for n, s, rs in sheet_pairs if any(s["view"].values())})
    # Rows whose original side is empty/False/0 say nothing about this file.
    for x in rows:
        if x["status"] in ("kept", "added") and x["orig"] in (0, None, {}, [], False) and x["feature"] != "edit applied":
            x["status"] = "n/a" if x["status"] == "kept" else "added"
    return {"parts": parts, "features": rows}


def to_markdown(res, title=""):
    def short(v):
        s = json.dumps(v, default=str) if not isinstance(v, (int, float, str)) else str(v)
        return s if len(s) <= 70 else s[:67] + "..."
    out = [f"### {title}", "", f"Parts: {res['parts']['common']} common ({res['parts']['identical']} canonically identical), "
           f"removed {len(res['parts']['removed'])}, added {len(res['parts']['added'])}.", ""]
    if res["parts"]["removed"]:
        out.append("Removed parts: " + ", ".join(res["parts"]["removed"][:30]))
        out.append("")
    out += ["| Feature | Original | Round-trip | Status |", "|---|---|---|---|"]
    for x in res["features"]:
        if x["status"] in ("n/a", "info") and not x["orig"]:
            continue
        out.append(f"| {x['feature']} | {short(x['orig'])} | {short(x['rt'])} | {x['status']} |")
    return "\n".join(out) + "\n"


def main():
    a = sys.argv[1:]
    orig, rt = a[0], a[1]
    edit = None
    if "--edit" in a:
        spec = a[a.index("--edit") + 1]
        cell, _, value = spec.partition("=")
        sheet, _, ref = cell.rpartition("!")
        edit = (sheet, ref, value)
    deps = json.load(open(a[a.index("--dependents") + 1])) if "--dependents" in a else ()
    res = compare(extract(orig), extract(rt), edit, deps)
    if "--json" in a:
        json.dump(res, open(a[a.index("--json") + 1], "w"), indent=1, default=str)
    md = to_markdown(res, f"{orig.rsplit('/', 1)[-1]} -> {rt}")
    if "--md" in a:
        open(a[a.index("--md") + 1], "w").write(md)
    if "--json" not in a and "--md" not in a:
        print(md)
    return res


if __name__ == "__main__":
    main()
