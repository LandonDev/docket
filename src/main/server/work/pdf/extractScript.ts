/**
 * The pdf pillar's Python job (docs/agents/work-pdf.md "The extract job"),
 * run by extract.ts with the toolchain's `pdf-tools` venv: pdfplumber reads
 * text and tables, pypdfium2 counts pages and draws them. It ships as a
 * string because the app is bundled: the converter writes it into the
 * job's scratch folder and runs `python -I <file>`. As `String.raw`, the
 * Python may hold no backtick and no dollar-brace.
 */
export const EXTRACT_PY = String.raw`"""temp-code pdf jobs (src/main/server/work/pdf/extract.ts). Three modes:
  count <in.pdf> <out.json>              {"pages": n}
  extract <in.pdf> <out.json> <opts.json> PdfExtract
  png <in.pdf> <out.png> <opts.json>      one page, or a region of it
A refusal is one line on stderr starting "tc-error: " and exit 3. Output
goes to files, never stdout: the runner keeps only the tail of stdout."""
import json
import sys

BLOCK_MAX = 4000
CELL_MAX = 2000
TEXT_MAX = 4_000_000
MAX_PIXELS = 2400 * 3400


def refuse(text):
    sys.stderr.write("tc-error: " + text + "\n")
    sys.exit(3)


def r4(v):
    return round(min(1.0, max(0.0, v)), 4)


def open_pdfium(path):
    import pypdfium2 as pdfium
    try:
        return pdfium.PdfDocument(path)
    except pdfium.PdfiumError as err:
        msg = str(err)
        if "password" in msg.lower():
            refuse("This PDF is encrypted, so it cannot be read here.")
        refuse("This file could not be read as a PDF: " + msg)


def count(path, out):
    doc = open_pdfium(path)
    with open(out, "w") as f:
        json.dump({"pages": len(doc)}, f)


# ── reading order ──────────────────────────────────────────────────────

def median_height(words):
    hs = sorted(w["bottom"] - w["top"] for w in words)
    return max(1.0, hs[len(hs) // 2])


def split(words, lo, hi, gap):
    """Groups of words cut where an empty band at least gap wide runs across all of them."""
    items = sorted(words, key=lambda w: w[lo])
    groups = [[items[0]]]
    reach = items[0][hi]
    for w in items[1:]:
        if w[lo] - reach >= gap:
            groups.append([w])
        else:
            groups[-1].append(w)
        reach = max(reach, w[hi])
    return groups


def lines_of(words):
    words = sorted(words, key=lambda w: (w["top"], w["x0"]))
    lines = []
    for w in words:
        h = max(1.0, w["bottom"] - w["top"])
        if lines and abs(w["top"] - lines[-1][0]["top"]) <= h * 0.5:
            lines[-1].append(w)
        else:
            lines.append([w])
    return [sorted(line, key=lambda w: w["x0"]) for line in lines]


def xy_cut(words, depth=0):
    """Recursive XY cut: paragraphs split by empty rows, columns by empty bands down the whole group.
    A band across many lines is a column's gutter; a wide space in one justified line is not."""
    h = median_height(words)
    if depth < 40:
        rows = split(words, "top", "bottom", h * 0.5)
        if len(rows) > 1:
            return [b for g in rows for b in xy_cut(g, depth + 1)]
        one_line = len(lines_of(words)) == 1
        cols = split(words, "x0", "x1", h * 3 if one_line else max(8.0, h))
        if len(cols) > 1:
            return [b for g in cols for b in xy_cut(g, depth + 1)]
    lines = lines_of(words)
    return [{
        "x0": min(w["x0"] for w in words), "x1": max(w["x1"] for w in words),
        "top": min(w["top"] for w in words), "bottom": max(w["bottom"] for w in words),
        "lines": [" ".join(w["text"] for w in line) for line in lines],
    }]


def join_lines(lines):
    text = ""
    for t in lines:
        t = t.strip()
        if not t:
            continue
        if not text:
            text = t
        elif text.endswith("-"):
            text += t
        else:
            text += " " + t
    return text


# ── extract ────────────────────────────────────────────────────────────

def extract(path, out, opts):
    import pdfplumber
    pages = opts["pages"]
    want_tables = opts.get("tables", True)
    result = {"pages": 0, "sizes": [], "blocks": [], "tables": [], "warnings": list(opts.get("notes", []))}
    used = 0
    try:
        pdf = pdfplumber.open(path)
    except Exception as err:
        name = type(err).__name__
        if "Password" in name or "Encrypt" in name:
            refuse("This PDF is encrypted, so it cannot be read here.")
        refuse("This file could not be read as a PDF: " + (str(err) or name))
    with pdf:
        total = len(pdf.pages)
        result["pages"] = total
        for n in pages:
            if n < 1 or n > total:
                refuse("Page %d is not in this file: it has %d %s." % (n, total, "page" if total == 1 else "pages"))
        for n in pages:
            if used > TEXT_MAX:
                result["warnings"].append("Cut after page %d: the text ran past %d MB. Ask for fewer pages." % (n - 1, TEXT_MAX // 1_000_000))
                break
            page = pdf.pages[n - 1]
            px0, ptop = page.bbox[0], page.bbox[1]
            w, h = float(page.width), float(page.height)
            result["sizes"].append({"page": n, "width": round(w, 3), "height": round(h, 3)})

            def box(x0, top, x1, bottom):
                return [r4((x0 - px0) / w), r4((top - ptop) / h), r4((x1 - px0) / w), r4((bottom - ptop) / h)]

            if not page.chars:
                if page.images:
                    result["warnings"].append("page %d has no text layer: it is a scan" % n)
                continue
            boxes = []
            if want_tables:
                try:
                    found = page.find_tables()
                except Exception as err:
                    found = []
                    result["warnings"].append("page %d: its tables could not be read (%s)" % (n, err))
                for t in found:
                    rows = [[(c or "")[:CELL_MAX] for c in row] for row in t.extract()]
                    # A ruled box with one cell is a frame, not a table: its text stays in the blocks.
                    if len(rows) < 2 and all(len(r) < 2 for r in rows):
                        continue
                    boxes.append(t.bbox)
                    result["tables"].append({"page": n, "bbox": box(*t.bbox), "rows": rows})
                    used += sum(len(c) for r in rows for c in r)

            # Turned text (a form's margin label) reads backwards in words: it is left out when the page has upright text.
            upright = any(c.get("upright", True) for c in page.chars)
            x1p, y1p = px0 + w, ptop + h

            def keep(obj):
                if obj.get("object_type") != "char":
                    return True
                if upright and not obj.get("upright", True):
                    return False
                cx = (obj["x0"] + obj["x1"]) / 2
                cy = (obj["top"] + obj["bottom"]) / 2
                # Printer's marks outside the page box are not on the page.
                if not (px0 <= cx <= x1p and ptop <= cy <= y1p):
                    return False
                return not any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in boxes)

            words = page.filter(keep).extract_words(keep_blank_chars=False, use_text_flow=False)
            for b in (xy_cut(words) if words else []):
                text = join_lines(b["lines"])
                if not text:
                    continue
                if len(text) > BLOCK_MAX:
                    text = text[:BLOCK_MAX] + " …"
                used += len(text)
                result["blocks"].append({"page": n, "bbox": box(b["x0"], b["top"], b["x1"], b["bottom"]), "text": text})
    with open(out, "w") as f:
        json.dump(result, f, ensure_ascii=False)


# ── a page's picture ───────────────────────────────────────────────────

def png(path, out, opts):
    doc = open_pdfium(path)
    # A filled form renders blank without this: the widgets' appearances are drawn only once forms are up.
    doc.init_forms()
    total = len(doc)
    n = opts["page"]
    if n < 1 or n > total:
        refuse("Page %d is not in this file: it has %d %s." % (n, total, "page" if total == 1 else "pages"))
    page = doc[n - 1]
    w, h = page.get_size()
    x0, y0, x1, y1 = opts.get("crop") or [0, 0, 1, 1]
    cw, ch = (x1 - x0) * w, (y1 - y0) * h
    if cw < 1 or ch < 1:
        refuse("That region of the page is empty.")
    scale = opts["width"] / cw
    if cw * scale * ch * scale > MAX_PIXELS:
        scale = (MAX_PIXELS / (cw * ch)) ** 0.5
    # pdfium crops by what to cut from each side, in points, bottom-left origin: left, bottom, right, top.
    crop = (x0 * w, (1 - y1) * h, (1 - x1) * w, y0 * h)
    bitmap = page.render(scale=scale, crop=crop, may_draw_forms=True)
    bitmap.to_pil().save(out, format="PNG")


def main():
    mode, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
    opts = {}
    if len(sys.argv) > 4:
        with open(sys.argv[4]) as f:
            opts = json.load(f)
    if mode == "count":
        count(src, out)
    elif mode == "extract":
        extract(src, out, opts)
    elif mode == "png":
        png(src, out, opts)
    else:
        refuse("unknown mode " + mode)


main()
`
