"""Makes the two build decks of the show's steps (docs/agents/work-slides.md "Builds"), with python-pptx and
hand-written timing XML the way PowerPoint writes it:

  python -I steps-make.py <kinds.pptx> <talk.pptx> <ffmpeg>

steps-kinds.pptx holds one kind of timing tree a slide, each slide's title naming it: what the reader turns into
steps and what makes a slide one step. steps-talk.pptx is a short talk built the way people build one: bullets
one by one, a picture after its caption, a box that leaves, a chart and a numbered footer. ffmpeg makes the one
second of test video the media slide holds."""
import subprocess
import sys
import tempfile
from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.util import Inches as I, Pt
from PIL import Image

P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
kinds_out, talk_out, ffmpeg = sys.argv[1], sys.argv[2], sys.argv[3]
tmp = tempfile.mkdtemp()


class Ids:
    def __init__(self):
        self.n = 1

    def __call__(self):
        self.n += 1
        return self.n


def tgt(spid, para=None, extra=''):
    if para is None:
        return '<p:spTgt spid="%d"/>' % spid if not extra else '<p:spTgt spid="%d">%s</p:spTgt>' % (spid, extra)
    return '<p:spTgt spid="%d"><p:txEl><p:pRg st="%d" end="%d"/></p:txEl></p:spTgt>' % (spid, para[0], para[1])


def effect(ids, kind, node, target, preset=None, delay=0, inner=''):
    """One effect as PowerPoint writes it: kind is entr, exit, emph, path or mediacall."""
    i = ids()
    if kind == 'entr' and preset in (None, 1):
        body = ('<p:set><p:cBhvr><p:cTn id="%d" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>'
                '<p:tgtEl>%s</p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>'
                '<p:to><p:strVal val="visible"/></p:to></p:set>') % (ids(), target)
        preset = 1
    elif kind == 'entr':
        body = ('<p:set><p:cBhvr><p:cTn id="%d" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>'
                '<p:tgtEl>%s</p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>'
                '<p:to><p:strVal val="visible"/></p:to></p:set>'
                '<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="%d" dur="500"/><p:tgtEl>%s</p:tgtEl></p:cBhvr></p:animEffect>') % (ids(), target, ids(), target)
    elif kind == 'exit':
        body = ('<p:animEffect transition="out" filter="fade"><p:cBhvr><p:cTn id="%d" dur="500"/><p:tgtEl>%s</p:tgtEl></p:cBhvr></p:animEffect>'
                '<p:set><p:cBhvr><p:cTn id="%d" dur="1" fill="hold"><p:stCondLst><p:cond delay="499"/></p:stCondLst></p:cTn>'
                '<p:tgtEl>%s</p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>'
                '<p:to><p:strVal val="hidden"/></p:to></p:set>') % (ids(), target, ids(), target)
        preset = preset or 10
    elif kind == 'emph':
        body = ('<p:animScale><p:cBhvr><p:cTn id="%d" dur="2000" fill="hold"/><p:tgtEl>%s</p:tgtEl></p:cBhvr>'
                '<p:by x="150000" y="150000"/></p:animScale>') % (ids(), target)
        preset = preset or 6
    elif kind == 'path':
        body = ('<p:animMotion origin="layout" path="M 0 0 L 0.25 0 E" pathEditMode="relative"><p:cBhvr><p:cTn id="%d" dur="2000" fill="hold"/>'
                '<p:tgtEl>%s</p:tgtEl><p:attrNameLst><p:attrName>ppt_x</p:attrName><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr></p:animMotion>') % (ids(), target)
        preset = preset or 42
    elif kind == 'mediacall':
        body = '<p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr><p:cTn id="%d" dur="1000" fill="hold"/><p:tgtEl>%s</p:tgtEl></p:cBhvr></p:cmd>' % (ids(), target)
        preset = preset or 1
    else:
        raise ValueError(kind)
    return ('<p:par><p:cTn id="%d" presetID="%d" presetClass="%s" presetSubtype="0" fill="hold" nodeType="%s">'
            '<p:stCondLst><p:cond delay="%d"/></p:stCondLst><p:childTnLst>%s%s</p:childTnLst></p:cTn></p:par>') % (i, preset, kind, node, delay, body, inner)


def group(ids, effects, delay):
    return '<p:par><p:cTn id="%d" fill="hold"><p:stCondLst><p:cond delay="%s"/></p:stCondLst><p:childTnLst>%s</p:childTnLst></p:cTn></p:par>' % (ids(), delay, ''.join(effects))


def click(ids, times, delay='indefinite'):
    """One press: its time groups, each a list of effects (with-previous inside one, after-previous the next)."""
    inner = ''.join(group(ids, t, 0 if k == 0 else 500 * k) for k, t in enumerate(times))
    return '<p:par><p:cTn id="%d" fill="hold"><p:stCondLst><p:cond delay="%s"/></p:stCondLst><p:childTnLst>%s</p:childTnLst></p:cTn></p:par>' % (ids(), delay, inner)


def main_seq(ids, clicks):
    return ('<p:seq concurrent="1" nextAc="seek"><p:cTn id="%d" dur="indefinite" nodeType="mainSeq"><p:childTnLst>%s</p:childTnLst></p:cTn>'
            '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
            '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>') % (ids(), ''.join(clicks))


def trigger_seq(ids, on, effects):
    return ('<p:seq concurrent="1" nextAc="seek"><p:cTn id="%d" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq">'
            '<p:stCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="%d"/></p:tgtEl></p:cond></p:stCondLst>'
            '<p:endSync evt="end" delay="0"><p:rtn val="all"/></p:endSync><p:childTnLst>%s</p:childTnLst></p:cTn>'
            '<p:nextCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="%d"/></p:tgtEl></p:cond></p:nextCondLst></p:seq>') % (
        ids(), on, click(ids, [effects], delay='0'), on)


def timing(slide, parts, builds=''):
    """Sets the slide's p:timing: parts are the root's children (the main sequence, a trigger, a media node)."""
    xml = ('<p:timing xmlns:p="%s"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>%s'
           '</p:childTnLst></p:cTn></p:par></p:tnLst>%s</p:timing>') % (P, ''.join(parts), '<p:bldLst>%s</p:bldLst>' % builds if builds else '')
    el = etree.fromstring(xml)
    root = slide._element
    # p:timing after p:transition (if any), before p:extLst
    ext = root.find('{%s}extLst' % P)
    if ext is not None:
        ext.addprevious(el)
    else:
        root.append(el)


def wide():
    prs = Presentation()
    prs.slide_width, prs.slide_height = I(13.333), I(7.5)
    return prs


def box(s, x, y, w, h, colour, words=None, kind=MSO_SHAPE.RECTANGLE):
    sh = s.shapes.add_shape(kind, I(x), I(y), I(w), I(h))
    sh.fill.solid()
    sh.fill.fore_color.rgb = RGBColor.from_string(colour)
    sh.line.fill.background()
    if words:
        sh.text_frame.text = words
        sh.text_frame.paragraphs[0].runs[0].font.size = Pt(20)
    return sh


def titled(prs, title, layout=5):
    s = prs.slides.add_slide(prs.slide_layouts[layout])
    s.shapes.title.text = title
    return s


def bullets(s, words, levels=None, anchor=None, fit=False, x=0.8, y=1.8, w=7.5, h=4.6):
    tb = s.shapes.add_textbox(I(x), I(y), I(w), I(h))
    tf = tb.text_frame
    tf.word_wrap = True
    if anchor is not None:
        tf.vertical_anchor = anchor
    for k, text in enumerate(words):
        p = tf.paragraphs[0] if k == 0 else tf.add_paragraph()
        p.text = text
        p.level = levels[k] if levels else 0
        p.runs[0].font.size = Pt(26 - 4 * p.level)
        # a real bullet, so its colour is made clear with the words
        ppr = p._p.get_or_add_pPr()
        ppr.set('marL', str(342900 + 342900 * p.level))
        ppr.set('indent', '-342900')
        bu = etree.SubElement(ppr, '{http://schemas.openxmlformats.org/drawingml/2006/main}buChar', char='•')
    if fit:
        tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
        body = tf._txBody.find('{http://schemas.openxmlformats.org/drawingml/2006/main}bodyPr')
        for c in list(body):
            body.remove(c)
        etree.SubElement(body, '{http://schemas.openxmlformats.org/drawingml/2006/main}normAutofit', fontScale='85000', lnSpcReduction='10000')
    return tb


def kinds():
    prs = wide()
    pic = tmp + '/pic.png'
    Image.new('RGB', (320, 200), '#3A6EA5').save(pic)

    # 1. three presses, one shape each
    s = titled(prs, 'Click groups')
    a, b, c = box(s, .8, 2, 3.4, 2.4, '2DA459', 'One'), box(s, 4.8, 2, 3.4, 2.4, 'E26A20', 'Two'), box(s, 8.8, 2, 3.4, 2.4, 'AD227C', 'Three')
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(x.shape_id), preset=10)]]) for x in (a, b, c)])])

    # 2. with previous and after previous folded into their press
    s = titled(prs, 'With previous and after previous')
    a, b, c, d = (box(s, .8 + 3 * k, 2.2, 2.6, 2, col, str(k + 1)) for k, col in enumerate(('2DA459', 'E26A20', 'AD227C', '154DC4')))
    ids = Ids()
    timing(s, [main_seq(ids, [
        click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(a.shape_id)), effect(ids, 'entr', 'withEffect', tgt(b.shape_id))], [effect(ids, 'entr', 'afterEffect', tgt(c.shape_id), preset=10)]]),
        click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(d.shape_id))]]),
    ])])

    # 3. exits: a box there from the start leaves, another comes
    s = titled(prs, 'Exits')
    a, b = box(s, 1, 2, 5, 3, 'D34B36', 'Leaves'), box(s, 7, 2, 5, 3, '2F9C78', 'Comes')
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'exit', 'clickEffect', tgt(a.shape_id))]]), click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(b.shape_id))]])])])

    # 4. a paragraph build: four bullets, one a press
    s = titled(prs, 'Paragraphs one by one')
    tb = bullets(s, ['Plan the season', 'Book the venue', 'Sell the tickets', 'Run the event'])
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(tb.shape_id, (k, k)), preset=10)]]) for k in range(4)])],
           '<p:bldP spid="%d" grpId="0" build="p"/>' % tb.shape_id)

    # 5. a paragraph build in a box anchored in the middle, its words shrunk to fit: clear words must not move the rest
    s = titled(prs, 'Paragraphs in the middle, shrunk to fit')
    tb = bullets(s, ['First point, long enough to wrap onto a second line in this box', 'Second point', 'Third point, a sub-point below', 'The sub-point'], levels=[0, 0, 0, 1], anchor=MSO_ANCHOR.MIDDLE, fit=True, w=6, h=3.6)
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(tb.shape_id, (k, k)))]]) for k in (0, 1)] + [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(tb.shape_id, (2, 3)))]])])])

    # 6. a trigger: pressing a shape plays an effect; the slide is shown whole
    s = titled(prs, 'A trigger')
    a, b = box(s, 1, 2, 4, 2.5, '154DC4', 'Press me'), box(s, 7, 2, 4, 2.5, 'E26A20', 'Shown')
    ids = Ids()
    timing(s, [trigger_seq(ids, a.shape_id, [effect(ids, 'entr', 'clickEffect', tgt(b.shape_id))])])

    # 7. an emphasis that is held: where it ends is not drawn, so the slide is shown whole
    s = titled(prs, 'An emphasis held')
    a, b = box(s, 1, 2, 4, 2.5, '2DA459', 'Grows'), box(s, 7, 2, 4, 2.5, 'AD227C', 'Comes')
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(b.shape_id))]]), click(ids, [[effect(ids, 'emph', 'clickEffect', tgt(a.shape_id))]])])])

    # 8. a motion path
    s = titled(prs, 'A motion path')
    a = box(s, 1, 2, 4, 2.5, '154DC4', 'Moves')
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'path', 'clickEffect', tgt(a.shape_id))]])])])

    # 9. a nesting the reader does not know: an effect one level too deep
    s = titled(prs, 'A nesting not known')
    a = box(s, 1, 2, 4, 2.5, 'D34B36', 'Deep')
    ids = Ids()
    deep = group(ids, [effect(ids, 'entr', 'clickEffect', tgt(a.shape_id))], 0)
    timing(s, [main_seq(ids, [click(ids, [[deep]])])])

    # 10. the first effects start by themselves when the slide comes, then one press
    s = titled(prs, 'After previous at the start')
    a, b = box(s, 1, 2, 4, 2.5, '2F9C78', 'At once'), box(s, 7, 2, 4, 2.5, 'E26A20', 'On a press')
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'afterEffect', tgt(a.shape_id))]], delay='0'), click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(b.shape_id))]])])])

    # 11. a video with PowerPoint's own play and pause on a press of it, and a caption on a press
    s = titled(prs, 'A video and a caption')
    clip = tmp + '/clip.mp4'
    subprocess.run([ffmpeg, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', clip], check=True)
    poster = tmp + '/poster.png'
    Image.new('RGB', (320, 180), '#202020').save(poster)
    v = s.shapes.add_movie(clip, I(1), I(1.8), I(6.4), I(3.6), poster_frame_image=poster, mime_type='video/mp4')
    cap = box(s, 8, 2.5, 4.5, 2, '154DC4', 'The caption')
    ids = Ids()
    toggle = ('<p:seq concurrent="1" nextAc="seek"><p:cTn id="%d" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq">'
              '<p:stCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="%d"/></p:tgtEl></p:cond></p:stCondLst>'
              '<p:endSync evt="end" delay="0"><p:rtn val="all"/></p:endSync><p:childTnLst>%s</p:childTnLst></p:cTn>'
              '<p:nextCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="%d"/></p:tgtEl></p:cond></p:nextCondLst></p:seq>')
    pause = ('<p:par><p:cTn id="%d" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="%d" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
             '<p:par><p:cTn id="%d" presetID="2" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
             '<p:cmd type="call" cmd="togglePause"><p:cBhvr><p:cTn id="%d" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="%d"/></p:tgtEl></p:cBhvr></p:cmd>'
             '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>') % (ids(), ids(), ids(), ids(), v.shape_id)
    media = ('<p:video><p:cMediaNode vol="80000"><p:cTn id="%d" fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn>'
             '<p:tgtEl><p:spTgt spid="%d"/></p:tgtEl></p:cMediaNode></p:video>') % (ids(), v.shape_id)
    # python-pptx writes a timing of its own for the movie: ours replaces it
    old = s._element.find('{%s}timing' % P)
    if old is not None:
        s._element.remove(old)
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(cap.shape_id))]])]), toggle % (ids(), v.shape_id, pause, v.shape_id), media])

    # 12. a group comes in whole
    s = titled(prs, 'A group')
    g = s.shapes.add_group_shape()
    box(g, 2, 2, 3, 2, '2DA459', 'In')
    box(g, 6, 3, 3, 2, 'AD227C', 'the group')
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(g.shape_id))]])])])

    # 13. a chart built by series: a part of a shape the reader does not know
    s = titled(prs, 'A chart by series')
    data = CategoryChartData()
    data.categories = ['Q1', 'Q2', 'Q3']
    data.add_series('Tickets', (120, 180, 240))
    ch = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, I(1), I(1.8), I(8), I(5), data)
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(ch.shape_id, extra='<p:graphicEl><a:chart xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" seriesIdx="-3" categoryIdx="-3" bldStep="gridLegend"/></p:graphicEl>'))]])])])

    # 14. a picture comes in with a fly-in: shown as a fade here, counted as changed
    s = titled(prs, 'A picture flies in')
    pc = s.shapes.add_picture(pic, I(4), I(2), I(5), I(3.1))
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(pc.shape_id), preset=2)]])])])
    prs.save(kinds_out)


def talk():
    prs = wide()
    pic = tmp + '/venue.png'
    img = Image.new('RGB', (640, 400), '#E8E2D4')
    for x in range(0, 640, 40):
        for y in range(0, 400, 40):
            if (x + y) // 40 % 2:
                img.paste((60, 110, 165), (x, y, x + 40, y + 40))
    img.save(pic)
    footer_n = []

    def numbered(s):
        # a slide number drawn by a field, as PowerPoint's footer does
        tb = s.shapes.add_textbox(I(12.2), I(6.9), I(.9), I(.4))
        p = tb.text_frame.paragraphs[0]
        fld = etree.SubElement(p._p, '{http://schemas.openxmlformats.org/drawingml/2006/main}fld', id='{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}', type='slidenum')
        etree.SubElement(fld, '{http://schemas.openxmlformats.org/drawingml/2006/main}rPr', lang='en-US', sz='1200')
        t = etree.SubElement(fld, '{http://schemas.openxmlformats.org/drawingml/2006/main}t')
        t.text = '‹#›'
        footer_n.append(tb)

    s = prs.slides.add_slide(prs.slide_layouts[0])
    s.shapes.title.text = 'Spring season'
    s.placeholders[1].text = 'Where we are and what comes next'

    # bullets one by one in the layout's own body placeholder, with a sub-level
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = 'What we did'
    body = s.placeholders[1]
    tf = body.text_frame
    for k, (text, level) in enumerate([('Moved the finals to the arena', 0), ('Two thousand seats, sold out', 1), ('Signed three new teams', 0), ('Opened the clinic on Saturdays', 0)]):
        p = tf.paragraphs[0] if k == 0 else tf.add_paragraph()
        p.text = text
        p.level = level
    numbered(s)
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(body.shape_id, (0, 1)), preset=10)]]),
                              click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(body.shape_id, (2, 2)), preset=10)]]),
                              click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(body.shape_id, (3, 3)), preset=10)]])])],
           '<p:bldP spid="%d" grpId="0" build="p"/>' % body.shape_id)

    # a caption, then its picture comes with it after the caption
    s = titled(prs, 'The new venue')
    cap = s.shapes.add_textbox(I(.8), I(1.7), I(5), I(1))
    cap.text_frame.text = 'Opens in March, ten minutes from campus'
    pc = s.shapes.add_picture(pic, I(6.4), I(1.6), I(6.2), I(3.9))
    numbered(s)
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(cap.shape_id))], [effect(ids, 'entr', 'afterEffect', tgt(pc.shape_id), preset=10)]])])])

    # a box with a question that leaves, and the answer that comes
    s = titled(prs, 'Can we grow?')
    q = box(s, 1, 2, 11, 1.4, 'D34B36', 'Do we have the staff for a second night?')
    a = box(s, 1, 4, 11, 1.4, '2F9C78', 'Yes: four new referees start in April')
    numbered(s)
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'exit', 'clickEffect', tgt(q.shape_id))], [effect(ids, 'entr', 'afterEffect', tgt(a.shape_id), preset=10)]])])])

    # a chart that comes on a press, its title there from the start
    s = titled(prs, 'Tickets by quarter')
    data = CategoryChartData()
    data.categories = ['Q1', 'Q2', 'Q3', 'Q4']
    data.add_series('This year', (120, 180, 240, 310))
    data.add_series('Last year', (100, 140, 150, 200))
    ch = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, I(1), I(1.7), I(11), I(5), data)
    numbered(s)
    ids = Ids()
    timing(s, [main_seq(ids, [click(ids, [[effect(ids, 'entr', 'clickEffect', tgt(ch.shape_id), preset=10)]])])])
    s = prs.slides.add_slide(prs.slide_layouts[0])
    s.shapes.title.text = 'Thank you'
    s.placeholders[1].text = 'Questions'
    prs.save(talk_out)


kinds()
talk()
