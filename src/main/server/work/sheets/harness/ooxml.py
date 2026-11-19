"""Small SpreadsheetML package reader shared by the lab scripts (lxml only)."""
import posixpath, re

from lxml import etree

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "x14": "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main",
    "xm": "http://schemas.microsoft.com/office/excel/2006/main",
    "tc": "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments",
}
_REF = re.compile(r"^\$?([A-Z]+)\$?(\d+)$")


def col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n - 1


def col_name(c):
    s = ""
    c += 1
    while c:
        c, r = divmod(c - 1, 26)
        s = chr(65 + r) + s
    return s


def split_ref(ref):
    m = _REF.match(ref.upper())
    return col_index(m.group(1)), int(m.group(2))


def range_cells(sqref, limit=200000):
    out = []
    for part in sqref.split():
        a, _, b = part.partition(":")
        c1, r1 = split_ref(a)
        c2, r2 = split_ref(b) if b else (c1, r1)
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                out.append(col_name(c) + str(r))
                if len(out) >= limit:
                    return out
    return out


def parse(data):
    parser = etree.XMLParser(remove_blank_text=True, huge_tree=True, recover=True)
    return etree.fromstring(data, parser)


def rels_path(part):
    d, b = posixpath.split(part)
    return posixpath.join(d, "_rels", b + ".rels")


def read_rels(z, part):
    """{rId: (type_suffix, target_part_or_url, external)}"""
    p = rels_path(part)
    try:
        root = parse(z.read(p))
    except KeyError:
        return {}
    out = {}
    base = posixpath.dirname(part)
    for rel in root:
        tgt = rel.get("Target", "")
        ext = rel.get("TargetMode") == "External"
        if not ext:
            tgt = tgt.lstrip("/") if tgt.startswith("/") else posixpath.normpath(posixpath.join(base, tgt))
        out[rel.get("Id")] = (rel.get("Type", "").rsplit("/", 1)[-1], tgt, ext)
    return out


def workbook_part(z):
    root = parse(z.read("_rels/.rels"))
    for rel in root:
        if rel.get("Type", "").endswith("/officeDocument"):
            return rel.get("Target").lstrip("/")
    return "xl/workbook.xml"


def sheet_parts(z, include_chartsheets=False):
    """Ordered {sheet name: part path} for worksheets (and chartsheets if asked)."""
    wb = workbook_part(z)
    rels = read_rels(z, wb)
    root = parse(z.read(wb))
    out = {}
    for s in root.iter("{%s}sheet" % NS["m"]):
        rid = s.get("{%s}id" % NS["r"])
        t, tgt, _ = rels.get(rid, ("", "", False))
        if t == "worksheet" or (include_chartsheets and t == "chartsheet"):
            out[s.get("name")] = tgt
    return out
