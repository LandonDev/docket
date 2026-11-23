"""A move, judged by what it must keep (structuralMoves.test.ts): the features xmldiff counts that a
move leaves in the file. Needs a python with lxml.

    python -I check_moves.py <orig.xlsx> <out.xlsx>

Prints one JSON line: the features xmldiff reports as lost among those a move keeps.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xmldiff  # noqa: E402

# Counted without their positions (a moved merge, name, note or link reads to xmldiff as another one, so the
# test holds those by place itself): check_structural.py's list, and the sheet's protection.
KEPT = {"sheets", "chartsheets", "vbaProject.bin byte-identical", "VBA macro source (olevba)", "metadata.xml (dynamic arrays)",
        "charts (chart parts)", "chart series", "chart types", "tables", "pivot tables", "pivot caches", "images in drawings",
        "media files (byte-identical)", "shapes/text boxes/buttons in drawings", "sparklines", "external links",
        "data validations by type", "conditional formats: rules by type", "persons (threaded comment authors)",
        "workbook content type", "sheet protection"}
feats = xmldiff.compare(xmldiff.extract(sys.argv[1]), xmldiff.extract(sys.argv[2]), None, []).get("features", [])
print(json.dumps({"lost": sorted(f["feature"] for f in feats if f["status"] == "lost" and f["feature"] in KEPT)}))
