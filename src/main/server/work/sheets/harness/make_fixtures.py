"""Makes the save, print, chart and patch fixtures of the editors plan's sheets lab again
(sheets-measure.md "Reproduce"). Needs XlsxWriter 3.3.4:

    python make_fixtures.py <out dir> save print charts patch

The print and patch workbooks kept in corpus/print and corpus/patch were made by this file; the
save workbooks are made by scripts/bench-sheet-save.ts itself (rowsWorkbook), in the same shape.
"""
from pathlib import Path
import shutil
import sys
import tempfile

import xlsxwriter

LAB = Path(sys.argv[1])
CORPUS = Path(__file__).parent / "corpus"
for _d in ("tmp", "save", "print", "patch"):
    (LAB / _d).mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(LAB / "tmp")


def save_fixtures():
    for n in (100, 10_000, 100_000, 500_000):
        with xlsxwriter.Workbook(LAB / "save" / f"rows-{n}.xlsx",
                                 {"constant_memory": True, "tmpdir": str(LAB / "tmp")}) as book:
            sheet = book.add_worksheet("Data")
            for r in range(n):
                sheet.write_number(r, 0, r + 1)
                sheet.write_number(r, 1, r + 2)
                if r % 10 == 0:
                    sheet.write_formula(r, 2, f"=A{r + 1}*2", None, (r + 1) * 2)
                if r == 0:
                    sheet.write_formula(r, 3, "=C1+1", None, 3)
    for n in (1000, 10_000, 100_000):
        with xlsxwriter.Workbook(LAB / "print" / f"speed-{n}.xlsx",
                                 {"constant_memory": True, "tmpdir": str(LAB / "tmp")}) as book:
            sheet = book.add_worksheet("Data")
            sheet.set_paper(1)
            sheet.set_margins(.5, .5, .5, .5)
            for r in range(n):
                sheet.write_row(r, 0, (r + 1, 2 * r, 3 * r, 4 * r))


def print_fixtures():
    rows_cols = {
        "landscape": (42, 9), "fit-width": (86, 12),
        "manual-breaks": (46, 8), "titles": (81, 6),
        "scale-70": (98, 9), "chart-print": (38, 10), "wide-columns": (45, 8),
    }
    for name, (rows, cols) in rows_cols.items():
        with xlsxwriter.Workbook(LAB / "print" / f"{name}.xlsx") as book:
            sheet = book.add_worksheet("Data")
            labels = book.add_format({"font_name": "Arial", "font_size": 10})
            sheet.set_paper(1)  # US Letter
            sheet.set_margins(.5, .5, .6, .6)
            sheet.set_column(0, cols - 1, 11)
            for row in range(rows):
                sheet.set_row(row, 15)
                for col in range(cols):
                    sheet.write_string(row, col, f"R{row + 1:03}C{col + 1:02}", labels)
            if name == "landscape":
                sheet.set_landscape()
                sheet.set_header("&CHeader &P of &N", {"margin": .2})
                sheet.set_footer("&CFooter &P of &N", {"margin": .2})
                for col, font in enumerate(("Calibri", "Aptos Narrow", "Arial")):
                    cell_font = book.add_format({"font_name": font, "font_size": 10})
                    sheet.write_string(3, col, f"FONT{col + 1}", cell_font)
            elif name == "fit-width":
                sheet.fit_to_pages(1, 0)
                sheet.set_h_pagebreaks([19])  # Excel ignores this in Fit to mode
            elif name == "manual-breaks":
                sheet.set_h_pagebreaks([13, 31])
                sheet.set_v_pagebreaks([3])
            elif name == "titles":
                sheet.repeat_rows(0, 1)
                sheet.repeat_columns(0)
                sheet.set_column(0, cols - 1, 21)  # force two horizontal slices
                sheet.print_across()
            elif name == "scale-70":
                sheet.set_print_scale(70)
            elif name == "chart-print":
                for r in range(6):
                    sheet.write_number(r, 10, r)
                    sheet.write_number(r, 11, (r + 1) ** 2)
                chart = book.add_chart({"type": "column"})
                chart.add_series({"categories": "=Data!$K$1:$K$6", "values": "=Data!$L$1:$L$6",
                                  "fill": {"color": "#E04020"}})
                chart.set_title({"name": "CHARTPROBE"})
                sheet.insert_chart("D5", chart, {"x_scale": .65, "y_scale": .7})
                sheet.print_area("C2:J38")
            elif name == "wide-columns":
                sheet.set_column(0, 1, 31)
                sheet.set_column(2, 4, 22)
                sheet.set_column(5, 7, 37)
                sheet.set_row(7, 38)
                sheet.set_row(8, 15, None, {"hidden": True})
                sheet.set_column(6, 6, 37, None, {"hidden": True})
    for file in ("links_dest.xlsx", "pivot.xlsx", "protect_print.xlsx"):
        shutil.copyfile(CORPUS / file, LAB / "print" / file)


def chart_fixture():
    with xlsxwriter.Workbook(LAB / "chart-types.xlsx") as book:
        sheet = book.add_worksheet("Data")
        sheet.write_row(0, 0, ("Quarter", "Sales", "Cost", "Time", "Bubble"))
        for r, label in enumerate(("Q1", "Q2", "Q3", "Q4"), 1):
            sheet.write_row(r, 0, (label, r * 4, r + 2, r * 1.25, r + 1))
        for i, (kind, subtype) in enumerate((("column", None), ("bar", "stacked"),
                                           ("line", None), ("pie", None), ("scatter", None),
                                           ("area", None), ("combo", None))):
            chart = book.add_chart({"type": "column" if kind == "combo" else kind,
                                    **({"subtype": subtype} if subtype else {})})
            series = {"name": "=Data!$B$1", "categories": "=Data!$D$2:$D$5" if kind == "scatter"
                      else "=Data!$A$2:$A$5", "values": "=Data!$B$2:$B$5"}
            if kind == "line":
                series["line"] = {"color": "#C02080"}
            elif kind == "scatter":
                series["marker"] = {"type": "circle", "fill": {"color": "#C02080"}}
            elif kind == "pie":
                series["points"] = [{"fill": {"color": "#C02080"}}, {}, {}, {}]
            else:
                series["fill"] = {"color": "#C02080"}
            chart.add_series(series)
            if kind == "bar":
                chart.add_series({"name": "=Data!$C$1", "values": "=Data!$C$2:$C$5"})
            if kind == "combo":
                line = book.add_chart({"type": "line"})
                line.add_series({"name": "=Data!$C$1", "categories": "=Data!$A$2:$A$5",
                                 "values": "=Data!$C$2:$C$5", "y2_axis": True,
                                 "line": {"color": "#005599"}})
                chart.combine(line)
                chart.set_y2_axis({"name": "Cost scale"})
            chart.set_title({"name": "=Data!$B$1" if kind == "scatter" else f"{kind} title"})
            sheet.insert_chart(7 + (i // 2) * 16, (i % 2) * 8, chart)


def patch_fixture():
    with xlsxwriter.Workbook(LAB / "patch" / "base.xlsx") as book:
        sheet = book.add_worksheet("Data")
        sheet.set_paper(1)
        sheet.set_column("B:B", 15)
        for row in range(28):
            sheet.write_row(row, 0, (row + 1, "keep", 2 * row, 3 * row))
        sheet.write_blank("A2", None, book.add_format({"num_format": "0.0"}))
        sheet.write("A2", 12.345, book.add_format({"num_format": "0.0"}))
        sheet.write_formula("C2", "=A2*2", None, 24.69)
        keep = book.add_worksheet("Untouched")
        keep.write("A1", "keep shared string")
        book.define_name("Existing", "=Untouched!$A$1")
        sheet.conditional_format("D3:D6", {"type": "cell", "criteria": "<", "value": 4,
                                          "format": book.add_format({"bg_color": "#440011"})})


if __name__ == "__main__":
    for name in sys.argv[2:]:
        {"save": save_fixtures, "print": print_fixtures, "charts": chart_fixture,
         "patch": patch_fixture}[name]()
