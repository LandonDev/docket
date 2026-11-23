"""Makes the box-test deck: one slide, one shape of each kind a hand might pick, each in one flat colour
nothing else on the slide has, so the pixels LibreOffice draws for it can be found and boxed."""
import sys
from pptx import Presentation
from pptx.util import Inches as I, Pt
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from PIL import Image

out, tmp = sys.argv[1], sys.argv[2]
prs = Presentation()
prs.slide_width, prs.slide_height = I(13.333), I(7.5)
s = prs.slides.add_slide(prs.slide_layouts[6])
targets = []

def fill(sh, colour):
    sh.fill.solid()
    sh.fill.fore_color.rgb = RGBColor.from_string(colour)
    sh.line.fill.background()

def auto(kind, x, y, w, h, colour, name, rot=0):
    sh = s.shapes.add_shape(kind, I(x), I(y), I(w), I(h))
    fill(sh, colour)
    sh.rotation = rot
    targets.append({'shape': sh.shape_id, 'name': name, 'fill': colour})
    return sh

auto(MSO_SHAPE.OVAL, .5, .5, 2.4, 1.4, 'D34B36', 'ellipse')
auto(MSO_SHAPE.RIGHT_ARROW, 3.4, .5, 2.6, 1.3, '154DC4', 'arrow')
auto(MSO_SHAPE.ROUNDED_RECTANGLE, 6.5, .5, 2.4, 1.3, '2DA459', 'rounded box')
auto(MSO_SHAPE.OVAL, 9.6, .6, 2.6, 1.2, 'AD227C', 'ellipse turned 30', rot=30)
auto(MSO_SHAPE.ISOSCELES_TRIANGLE, .6, 2.6, 2.0, 1.6, 'E26A20', 'triangle')

# a text box with a fill: its frame is its box
tb = s.shapes.add_textbox(I(3.4), I(2.6), I(2.8), I(1.2))
tb.text_frame.text = 'Words'
fill(tb, '2F9C78')
targets.append({'shape': tb.shape_id, 'name': 'text box', 'fill': '2F9C78'})

# a picture of one flat colour
Image.new('RGB', (300, 180), '#8A295C').save(tmp + '/flat.png')
pic = s.shapes.add_picture(tmp + '/flat.png', I(6.9), I(2.6), I(2.5), I(1.5))
targets.append({'shape': pic.shape_id, 'name': 'picture', 'fill': '8A295C'})

# a table whose every cell has the fill, with one short word a cell so no row grows
frame = s.shapes.add_table(2, 2, I(10), I(2.6), I(2.8), I(1.4))
for r in range(2):
    for c in range(2):
        cell = frame.table.cell(r, c)
        cell.text = 'a'
        cell.fill.solid()
        cell.fill.fore_color.rgb = RGBColor.from_string('492789')
        cell.text_frame.paragraphs[0].runs[0].font.size = Pt(10)
targets.append({'shape': frame.shape_id, 'name': 'table', 'fill': '492789'})

# a connector, as thick as a line can be
line = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, I(.6), I(5.2), I(4.6), I(6.6))
line.line.color.rgb = RGBColor.from_string('A0461E')
line.line.width = Pt(6)
targets.append({'shape': line.shape_id, 'name': 'connector', 'fill': 'A0461E'})

# a chart whose plot and chart area are one flat colour
data = CategoryChartData()
data.categories = ['a', 'b']
data.add_series('s', (1, 2))
gf = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, I(5.4), I(4.6), I(3.2), I(2.4), data)
from pptx.oxml.ns import qn
from lxml import etree
cs = gf.chart._chartSpace
sp = etree.SubElement(cs, qn('c:spPr'))
sf = etree.SubElement(sp, '{http://schemas.openxmlformats.org/drawingml/2006/main}solidFill')
etree.SubElement(sf, '{http://schemas.openxmlformats.org/drawingml/2006/main}srgbClr').set('val', 'CC3552')
targets.append({'shape': gf.shape_id, 'name': 'chart', 'fill': 'CC3552'})

# a video, by its poster of one flat colour
Image.new('RGB', (320, 180), '#207EB6').save(tmp + '/poster.png')
open(tmp + '/clip.mp4', 'wb').write(b'\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom')
mv = s.shapes.add_movie(tmp + '/clip.mp4', I(9.4), I(4.7), I(3.2), I(1.8), poster_frame_image=tmp + '/poster.png', mime_type='video/mp4')
targets.append({'shape': mv.shape_id, 'name': 'video', 'fill': '207EB6'})

prs.save(out)
import json
json.dump(targets, open(tmp + '/targets.json', 'w'))
print(len(targets), 'shapes')
