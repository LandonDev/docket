"""Makes the nine part-local patches of corpus/patch from corpus/patch/base.xlsx (the editors
plan's sheets lab, sheets-measure.md section 2). Needs lxml and openpyxl:

    python make_patches.py <work dir> emit     # writes <name>.json: each changed part's XML
    python make_patches.py <work dir> verify   # reads each <name>.xlsx back with openpyxl

Between the two, the parts are fed to the production zip writer (harness/fixtures.test.ts does
the same from the kept <name>.parts.json).
"""
from copy import deepcopy
from pathlib import Path
from zipfile import ZipFile
import json

from lxml import etree as ET
import openpyxl

import sys

WORK = Path(sys.argv[1])
BASE = WORK / "base.xlsx"
NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
STYLES = "xl/styles.xml"
SHEET = "xl/worksheets/sheet1.xml"
BOOK = "xl/workbook.xml"
ORDER = {
    SHEET: """sheetPr dimension sheetViews sheetFormatPr cols sheetData sheetCalcPr sheetProtection
        protectedRanges scenarios autoFilter sortState dataConsolidate customSheetViews mergeCells
        phoneticPr conditionalFormatting dataValidations hyperlinks printOptions pageMargins pageSetup
        headerFooter rowBreaks colBreaks customProperties cellWatches ignoredErrors smartTags drawing
        legacyDrawing legacyDrawingHF picture oleObjects controls webPublishItems tableParts extLst""",
    STYLES: """numFmts fonts fills borders cellStyleXfs cellXfs cellStyles dxfs tableStyles colors extLst""",
    BOOK: """fileVersion fileSharing workbookPr workbookProtection bookViews sheets functionGroups
        externalReferences definedNames calcPr oleSize customWorkbookViews pivotCaches smartTagPr
        smartTagTypes webPublishing fileRecoveryPr webPublishObjects extLst""",
}


def tag(name):
    return f"{{{NS}}}{name}"


def xml(snippet):
    # The snippet carries the sheet namespace when it is attached to the existing tree.
    return ET.fromstring(snippet.replace(" ", f' xmlns="{NS}" ', 1) if " " in
                         snippet.split(">", 1)[0] else
                         snippet.replace(">", f' xmlns="{NS}">', 1))


def put(root, part, name, *, reuse=True):
    old = root.find(tag(name))
    if reuse and old is not None:
        return old
    element = ET.Element(tag(name))
    order = ORDER[part].split()
    index = order.index(name)
    for i, child in enumerate(root):
        child_name = ET.QName(child).localname
        if child_name in order and order.index(child_name) > index:
            root.insert(i, element)
            return element
    root.append(element)
    return element


def append(node, child):
    index = len(node)
    node.append(child)
    node.set("count", str(len(node)))
    return index


def set_style(sheet, styles):
    cell = sheet.find(f".//{tag('c')}[@r='A2']")
    xfs = styles.find(tag("cellXfs"))
    new_xf = deepcopy(xfs[int(cell.get("s", 0))])
    fonts = styles.find(tag("fonts"))
    new_font = deepcopy(fonts[int(new_xf.get("fontId", 0))])
    new_font.insert(0, ET.Element(tag("b")))
    font_id = append(fonts, new_font)
    fill_id = append(styles.find(tag("fills")), xml(
        '<fill><patternFill patternType="solid"><fgColor rgb="FFFFDD66"/>'
        '<bgColor indexed="64"/></patternFill></fill>'))
    border_id = append(styles.find(tag("borders")), xml(
        '<border><left style="thin"><color rgb="FF224466"/></left>'
        '<right/><top/><bottom/><diagonal/></border>'))
    formats = put(styles, STYLES, "numFmts")
    format_id = max([163] + [int(fmt.get("numFmtId")) for fmt in formats]) + 1
    append(formats, xml(f'<numFmt numFmtId="{format_id}" formatCode="0.000 &quot;kg&quot;"/>'))
    for topic, value in (("Font", font_id), ("Fill", fill_id), ("Border", border_id),
                         ("NumberFormat", format_id)):
        attribute = "numFmtId" if topic == "NumberFormat" else topic.lower() + "Id"
        new_xf.set(attribute, str(value))
        new_xf.set("apply" + topic, "1")
    cell.set("s", str(append(xfs, new_xf)))


def edit(which, originals):
    nodes = {name: ET.fromstring(data) for name, data in originals.items()}
    sheet, styles, book = (nodes[name] for name in (SHEET, STYLES, BOOK))
    if which in {"style", "combined"}:
        set_style(sheet, styles)
    if which in {"layout", "combined"}:
        col = sheet.find(f"{tag('cols')}/{tag('col')}[@min='2']")
        assert col.get("max") == "2"
        col.set("width", "22")
        col.set("customWidth", "1")
        row = sheet.find(f"{tag('sheetData')}/{tag('row')}[@r='3']")
        row.set("ht", "25")
        row.set("customHeight", "1")
        append(put(sheet, SHEET, "mergeCells"), xml('<mergeCell ref="E2:F2"/>'))
        sheet.find(tag("dimension")).set("ref", "A1:F28")
    if which in {"cf", "combined"}:
        dxf = append(put(styles, STYLES, "dxfs"), xml(
            '<dxf><fill><patternFill><bgColor rgb="FFFFAAAA"/></patternFill></fill></dxf>'))
        priority = 1 + max(int(rule.get("priority")) for rule in sheet.iter(tag("cfRule")))
        cf = put(sheet, SHEET, "conditionalFormatting", reuse=False)
        cf.set("sqref", "A5:A20")
        cf.append(xml(f'<cfRule type="cellIs" dxfId="{dxf}" priority="{priority}" operator="greaterThan">'
                      '<formula>10</formula></cfRule>'))
    if which in {"validation", "combined"}:
        append(put(sheet, SHEET, "dataValidations"), xml(
            '<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="B5:B20">'
            '<formula1>"yes,no"</formula1></dataValidation>'))
    if which in {"name", "combined"}:
        put(book, BOOK, "definedNames").append(xml(
            '<definedName name="Inputs">Data!$A$5:$A$20</definedName>'))
    if which in {"filter", "combined"}:
        put(sheet, SHEET, "autoFilter").set("ref", "A1:D28")
    if which in {"page", "page-fixed", "combined"}:
        fit_mode = which != "page-fixed"
        setup = put(sheet, SHEET, "sheetPr")
        setup.append(xml(f'<pageSetUpPr fitToPage="{int(fit_mode)}"/>'))
        page = put(sheet, SHEET, "pageSetup")
        page.set("orientation", "landscape")
        page.set("paperSize", "1")
        for name, value in (("fitToWidth", "1"), ("fitToHeight", "0")) if fit_mode else (("scale", "100"),):
            page.set(name, value)
        put(sheet, SHEET, "headerFooter").append(xml('<oddHeader>&amp;C&amp;P of &amp;N</oddHeader>'))
        breaks = put(sheet, SHEET, "rowBreaks")
        append(breaks, xml('<brk id="9" min="0" max="16383" man="1"/>'))
        breaks.set("manualBreakCount", "1")
        put(book, BOOK, "definedNames").append(xml(
            '<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$D$19</definedName>'))
    return {
        part: ET.tostring(node, encoding="UTF-8", xml_declaration=True, standalone=True).decode()
        for part, node in nodes.items()
        if ET.tostring(node) != ET.tostring(ET.fromstring(originals[part]))
    }


def verify(path, which):
    wb = openpyxl.load_workbook(path)
    ws = wb["Data"]
    assert (ws["A2"].value, ws["C2"].value, wb["Untouched"]["A1"].value) == (
        12.345, "=A2*2", "keep shared string")
    checks = {}
    if which in {"style", "combined"}:
        cell = ws["A2"]
        checks["style"] = [cell.font.bold, cell.fill.fgColor.rgb, cell.number_format,
                           cell.border.left.style, cell.border.left.color.rgb]
        assert checks["style"] == [True, "FFFFDD66", '0.000 "kg"', "thin", "FF224466"]
    if which in {"layout", "combined"}:
        checks["layout"] = [ws.column_dimensions["B"].width, ws.row_dimensions[3].height,
                            str(ws.merged_cells)]
        assert checks["layout"] == [22, 25, "E2:F2"]
    if which in {"cf", "combined"}:
        checks["cf"] = [[str(group.sqref), [(rule.type, rule.operator, rule.formula,
                          rule.dxfId, rule.priority, rule.dxf.fill.bgColor.rgb)
                         for rule in ws.conditional_formatting[group]]]
                        for group in ws.conditional_formatting]
        assert ["A5:A20", [("cellIs", "greaterThan", ["10"], 1, 2, "FFFFAAAA")]] in checks["cf"]
    if which in {"validation", "combined"}:
        checks["dv"] = [(item.type, str(item.sqref), item.formula1)
                        for item in ws.data_validations.dataValidation]
        assert checks["dv"] == [("list", "B5:B20", '"yes,no"')]
    if which in {"name", "combined"}:
        checks["name"] = list(wb.defined_names["Inputs"].destinations)
        assert checks["name"] == [("Data", "$A$5:$A$20")]
    if which in {"filter", "combined"}:
        checks["filter"] = ws.auto_filter.ref
        assert checks["filter"] == "A1:D28"
    if which in {"page", "page-fixed", "combined"}:
        checks["page"] = [ws.page_setup.orientation, ws.page_setup.fitToWidth,
                          ws.page_setup.fitToHeight, ws.sheet_properties.pageSetUpPr.fitToPage,
                          ws.print_area, [(item.id, item.man) for item in ws.row_breaks.brk],
                          ws.oddHeader.center.text]
        assert checks["page"] == ["landscape", 1 if which != "page-fixed" else None,
                                  0 if which != "page-fixed" else None,
                                  which != "page-fixed", "'Data'!$A$1:$D$19",
                                  [(9, True)], "&P of &N"]
    wb.close()
    return checks


if __name__ == "__main__":
    import sys

    operations = ("style", "layout", "cf", "validation", "name", "filter", "page", "page-fixed", "combined")
    if sys.argv[2] == "emit":
        with ZipFile(BASE) as z:
            originals = {name: z.read(name) for name in (SHEET, STYLES, BOOK)}
        for operation in operations:
            (WORK / f"{operation}.json").write_text(json.dumps(edit(operation, originals)))
    elif sys.argv[2] == "verify":
        for operation in operations:
            print(operation, json.dumps(verify(WORK / f"{operation}.xlsx", operation)))
