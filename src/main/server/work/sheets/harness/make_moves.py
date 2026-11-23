"""Makes the move fixtures (corpus/moves), dummy workbooks for the cases the move tests prove or refuse
(docs/agents/work-sheets.md "Structural edits"). Needs XlsxWriter 3.3.4:

    python -I make_moves.py <harness/corpus/moves>

Values are cached as Excel would compute them, so a reader that does not calculate sees the truth.
"""
import io
import re
import sys
import zipfile
from pathlib import Path

import xlsxwriter

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)


def refs():
    """Formulas, names and a chart that point at the block A1:B3 of Data, cells where it may land, and a range
    (A4:A6) that a formula on each sheet and a name read whole: a block may take its middle, never an end alone."""
    with xlsxwriter.Workbook(OUT / "refs.xlsx") as book:
        data = book.add_worksheet("Data")
        calc = book.add_worksheet("Calc")
        data.write_row(0, 0, (1, 2))
        data.write_row(1, 0, (3, 4))
        data.write_formula("A3", "=D10*2", None, 10)      # inside the block, pointing out
        data.write_formula("B3", "=A1+B2", None, 5)       # inside the block, pointing in
        for r, v in ((3, 10), (4, 20), (5, 30)):
            data.write_number(r, 0, v)
        data.write_formula("D1", "=A1", None, 1)          # a moved cell
        data.write_formula("D2", "=SUM(A1:B3)", None, 20)  # the whole block
        data.write_formula("D3", "=SUM(A4:A6)", None, 60)  # a range beside the block
        data.write_formula("D4", "=SUM(Block)", None, 20)
        data.write_formula("D5", "=SUM(Part)", None, 60)
        data.write_formula("D6", "=Single*1", None, 1)
        data.write_formula("D7", "=H1", None, "old")      # a cell the block may land on
        data.write_number("D10", 5)
        data.write_string("H1", "old")
        data.write_number("H2", 7)
        calc.write_formula("A1", "=Data!A1", None, 1)
        calc.write_formula("A2", "=SUM(Data!A1:B3)", None, 20)
        calc.write_formula("A3", "=SUM(Data!A4:A6)", None, 60)
        book.define_name("Block", "=Data!$A$1:$B$3")
        book.define_name("Part", "=Data!$A$4:$A$6")
        book.define_name("Single", "=Data!$A$1")
        chart = book.add_chart({"type": "column"})
        chart.add_series({"name": "Block", "categories": "=Data!$A$1:$A$3", "values": "=Data!$B$1:$B$3"})
        data.insert_chart("J20", chart)


def rules():
    """Conditional formats, validations, a link, a note and merges over and beside the block A1:C3, rules where a
    block may land (N5:P7), and two conditional formats that overlap (R21:S23 and R21:R30)."""
    with xlsxwriter.Workbook(OUT / "rules.xlsx") as book:
        data = book.add_worksheet("Data")
        red = book.add_format({"bg_color": "#FFC7CE"})
        bold = book.add_format({"bold": True, "num_format": "0.00"})
        data.write_row(0, 0, (1, 2, 3), bold)
        data.write_row(1, 0, (4, 5, 6))
        data.write_row(2, 0, (7, 8, 9))
        data.write_column(3, 0, (10, 11, 12, 13, 14, 15, 16))
        # one wholly inside the block A1:C3 and the rows 1:3, one over part of them; the two share no cell
        data.conditional_format("A1:B3", {"type": "cell", "criteria": ">", "value": 2, "format": red})
        data.conditional_format("C1:C10", {"type": "cell", "criteria": "<", "value": 0, "format": red})
        data.data_validation("A1:B3", {"validate": "integer", "criteria": "between", "minimum": 0, "maximum": 100})
        data.data_validation("C2:C10", {"validate": "list", "source": ["3", "6", "9"]})
        data.write_url("A2", "https://example.com/a2", None, "4")
        data.write_comment("B1", "A note on B1")
        # rules where a block may land
        data.conditional_format("N5:P7", {"type": "cell", "criteria": ">", "value": 50, "format": red})
        data.data_validation("N5:P7", {"validate": "decimal", "criteria": ">=", "value": 0})
        # a merge inside the block F1:G3, and one across the edge of the block I1:I3
        data.merge_range("F1:G1", "merged", None)
        data.write_row(1, 5, ("f2", "g2"))
        data.write_row(2, 5, ("f3", "g3"))
        data.write_string("I1", "i1")
        data.merge_range("I2:J2", "across", None)
        data.write_string("I3", "i3")
        # two conditional formats that share cells: the first is tried first on R21:R23
        # (every rule of this sheet differs from the others: LibreOffice joins two formats that hold the same rule)
        data.write_column(20, 17, (1, 2, 3))
        data.conditional_format("R21:S23", {"type": "cell", "criteria": ">", "value": 7, "format": red})
        data.conditional_format("R21:R30", {"type": "cell", "criteria": "<", "value": -5, "format": red})


def tables():
    """A table, a formula with a structured reference to it, and plain cells beside it."""
    with xlsxwriter.Workbook(OUT / "tables.xlsx") as book:
        data = book.add_worksheet("Data")
        data.add_table("A1:B4", {"name": "Sales", "columns": [{"header": "Item"}, {"header": "Amount"}],
                                 "data": [["a", 1], ["b", 2], ["c", 3]]})
        data.write_formula("D1", "=SUM(Sales[Amount])", None, 6)
        data.write_column(0, 5, (100, 200, 300))
        data.write_formula("D2", "=SUM(F1:F3)", None, 600)
        for r in range(5, 8):
            data.write_number(r, 0, r)


def arrays():
    """A legacy array formula, a dynamic array's spill, and a shared formula group (written into the XML after)."""
    buf = OUT / "arrays.xlsx"
    with xlsxwriter.Workbook(buf) as book:
        data = book.add_worksheet("Data")
        data.write_column(0, 0, (1, 2, 3))
        data.write_array_formula("C1:C3", "{=A1:A3*2}", None, 2)
        data.write_dynamic_array_formula("E1:E3", "=SEQUENCE(3)", None, 1)
        for r in range(3):
            data.write_formula(r, 6, f"=A{r + 1}*10", None, (r + 1) * 10)
        data.write_formula("I1", "=SUM(C1:C3)", None, 12)
        data.write_formula("I2", "=SUM(G1:G3)", None, 60)
    # XlsxWriter writes no shared formulas: G1:G3 become one group, as Excel writes a fill.
    z = zipfile.ZipFile(buf)
    parts = {n: z.read(n) for n in z.namelist()}
    z.close()
    xml = parts["xl/worksheets/sheet1.xml"].decode()
    xml = xml.replace("<f>A1*10</f>", '<f t="shared" ref="G1:G3" si="0">A1*10</f>')
    xml = re.sub(r"<f>A[23]\*10</f>", '<f t="shared" si="0"/>', xml)
    parts["xl/worksheets/sheet1.xml"] = xml.encode()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n, b in parts.items():
            z.writestr(n, b)


def layout():
    """A frozen pane, the sheet's filter, and a protected sheet."""
    with xlsxwriter.Workbook(OUT / "layout.xlsx") as book:
        data = book.add_worksheet("Data")
        data.freeze_panes(2, 0)
        data.write_row(0, 0, ("Name", "Qty", "Price"))
        for r in range(1, 10):
            data.write_row(r, 0, (f"item{r}", r, r * 1.5))
        data.autofilter("A1:C10")
        data.write_formula("E1", "=SUM(B2:B10)", None, 45)
        locked = book.add_worksheet("Locked")
        locked.write_column(0, 0, (1, 2, 3))
        locked.protect()


def reads():
    """Rules whose formulas read other cells: a conditional format by H1, a validation's list in H3:H7, a data bar
    whose lowest value is J1, and a conditional format that reads the very cell it is on (E1:E5)."""
    with xlsxwriter.Workbook(OUT / "reads.xlsx") as book:
        data = book.add_worksheet("Data")
        red = book.add_format({"bg_color": "#FFC7CE"})
        data.write_column(0, 0, (1, 2, 3, 4, 5))
        data.write_column(0, 4, (1, 2, 3, 4, 5))
        data.write_number("H1", 6)
        data.write_column(2, 7, ("a", "b", "c", "d", "e"))
        data.write_number("J1", 0)
        data.write_column(0, 11, (7, 8, 9))
        data.conditional_format("A1:A5", {"type": "formula", "criteria": "=$H$1>5", "format": red})
        data.data_validation("C1:C5", {"validate": "list", "source": "=$H$3:$H$7"})
        data.conditional_format("E1:E5", {"type": "formula", "criteria": "=E1>2", "format": red})
        data.conditional_format("G1:G5", {"type": "data_bar", "data_bar_2010": True, "min_type": "formula", "min_value": "=$J$1"})


def names():
    """Two charts over the same values: one series named by typed text, the other from a cell."""
    with xlsxwriter.Workbook(OUT / "names.xlsx") as book:
        data = book.add_worksheet("Data")
        other = book.add_worksheet("Other")
        data.write_column(0, 0, ("Month", "Jan", "Feb", "Mar", "Apr"))
        data.write_column(0, 1, ("Spend", 10, 20, 30, 40))
        data.write_string("H1", "From a cell")
        other.write_column(0, 0, (1, 2, 3))
        for at, name in (("D8", "Budget"), ("D24", "=Data!$H$1")):
            chart = book.add_chart({"type": "column"})
            chart.add_series({"name": name, "categories": "=Data!$A$2:$A$5", "values": "=Data!$B$2:$B$5"})
            data.insert_chart(at, chart)


def full():
    """A sheet whose last row and last column are in use: there is no room to move rows or columns in."""
    with xlsxwriter.Workbook(OUT / "full.xlsx") as book:
        data = book.add_worksheet("Data")
        data.write_column(0, 0, (1, 2, 3))
        data.write_number(1048575, 0, 9)
        data.write_number(0, 16383, 9)


for make in (refs, rules, tables, arrays, layout, reads, names, full):
    make()
