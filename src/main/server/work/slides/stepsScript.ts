/**
 * The show's Python tool (steps.ts), run with python-pptx's venv python and -I. A string, not a .py file: the app
 * is bundled, so a file beside this one would not ship. No backticks inside.
 */
export const STEPS_PY = String.raw`"""The show's step tool (src/main/server/work/slides/steps.ts).

  steps.py hide <in.pptx> <plan.json> <out.pptx>
  steps.py media <in.pptx> <slide id> <shape id> <out>

hide writes a copy of the deck in which, slide by slide, what a step has not shown yet (or has taken away) is
not seen. plan.json: {"256": {"shapes": [4, 7], "paras": [[5, [0, 1]]]}}. A shape is taken out of the slide's
tree (a group with all it holds); a paragraph keeps its place and its size, its words made fully clear and its
bullet a character of no width, so nothing around it moves; the numbered paragraphs still seen keep their numbers.
Every other part is copied as it is.

media writes the bytes of the video or sound a shape on a slide plays, from the package.

On failure: one sentence on stderr, exit 1.
"""
import json
import posixpath
import sys
import zipfile

from lxml import etree

NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
PARSER = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True)
P = lambda t: '{%s}%s' % (NS_P, t)
A = lambda t: '{%s}%s' % (NS_A, t)
SHAPES = {P('sp'), P('pic'), P('grpSp'), P('graphicFrame'), P('cxnSp'), P('contentPart')}


class Fail(Exception):
    """Its message is the sentence the owner reads."""


def rels_of(raw, part):
    """A part's relationships: id to (target part, external)."""
    d, f = posixpath.split(part)
    name = posixpath.join(d, '_rels', f + '.rels')
    if name not in raw:
        return {}
    out = {}
    for r in etree.fromstring(raw[name], PARSER):
        ext = r.get('TargetMode') == 'External'
        out[r.get('Id')] = (r.get('Target') if ext else posixpath.normpath(posixpath.join(d, r.get('Target', ''))).lstrip('/'), ext)
    return out


def slide_part(raw, sid):
    pres = etree.fromstring(raw['ppt/presentation.xml'], PARSER)
    rels = rels_of(raw, 'ppt/presentation.xml')
    for s in pres.iter(P('sldId')):
        if s.get('id') == str(sid):
            got = rels.get(s.get('{%s}id' % NS_R))
            if got and not got[1] and got[0] in raw:
                return got[0]
    raise Fail('the deck has no slide %s' % sid)


def shape_by_id(tree, sid):
    """The shape element whose own id is sid: an element of the slide's tree, or the mc:AlternateContent around it."""
    for c in tree.iter(P('cNvPr')):
        if c.get('id') != str(sid):
            continue
        el = c.getparent().getparent()
        if el.tag not in SHAPES:
            continue
        up = el.getparent()
        if up is not None and up.tag in ('{%s}Choice' % NS_MC, '{%s}Fallback' % NS_MC):
            return up.getparent()
        return el
    return None


def clear_colour(tag):
    el = etree.Element(A(tag))
    c = etree.SubElement(el, A('srgbClr'), val='FFFFFF')
    etree.SubElement(c, A('alpha'), val='0')
    return el


# CT_TextCharacterProperties: a:ln, then the fill, then the effects, then the rest; CT_TextParagraphProperties
# holds the bullet's colour, size and font after its spacing, then the bullet itself.
FILLS = {A('noFill'), A('solidFill'), A('gradFill'), A('blipFill'), A('pattFill'), A('grpFill')}
RPR_AFTER = [A(t) for t in ('effectLst', 'effectDag', 'highlight', 'uLnTx', 'uLn', 'uFillTx', 'uFill', 'latin', 'ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst')]
PPR_AFTER = [A(t) for t in ('buSzTx', 'buSzPct', 'buSzPts', 'buFontTx', 'buFont', 'buNone', 'buAutoNum', 'buChar', 'buBlip', 'tabLst', 'defRPr', 'extLst')]
BULLETS = (A('buNone'), A('buAutoNum'), A('buChar'), A('buBlip'))


def put(parent, el, before):
    for i, c in enumerate(parent):
        if c.tag in before:
            parent.insert(i, el)
            return
    parent.append(el)


def clear_run(rpr):
    for c in list(rpr):
        if c.tag in FILLS or c.tag in (A('effectLst'), A('effectDag'), A('highlight'), A('uFillTx'), A('uFill')):
            rpr.remove(c)
    put(rpr, clear_colour('solidFill'), RPR_AFTER)
    # no shadow or glow around the clear words, and the underline in their own clear colour
    put(rpr, etree.Element(A('effectLst')), RPR_AFTER[1:])
    put(rpr, etree.Element(A('uFillTx')), RPR_AFTER[6:])
    ln = rpr.find(A('ln'))
    if ln is not None:
        for c in list(ln):
            if c.tag in FILLS:
                ln.remove(c)
        ln.insert(0, etree.Element(A('noFill')))


def clear_paragraph(p):
    for r in p:
        if r.tag in (A('r'), A('fld')):
            rpr = r.find(A('rPr'))
            if rpr is None:
                rpr = etree.Element(A('rPr'))
                r.insert(0, rpr)
            clear_run(rpr)
    ppr = p.find(A('pPr'))
    if ppr is None:
        ppr = etree.Element(A('pPr'))
        p.insert(0, ppr)
    # LibreOffice draws a bullet in its colour whatever the colour's alpha, so a clear colour still shows the mark.
    # The mark becomes a character of no width instead: the paragraph keeps its indents, so its lines break where
    # they did, with a bullet of its own or one from its layout. A paragraph set to have none keeps none.
    if ppr.find(A('buNone')) is None:
        for c in list(ppr):
            if c.tag in BULLETS:
                ppr.remove(c)
        mark = etree.Element(A('buChar'))
        mark.set('char', '\u200b')
        put(ppr, mark, PPR_AFTER[9:])


def numbers(ps):
    """The number PowerPoint gives each paragraph that carries its own a:buAutoNum, by its place in ps: one kind at
    one level counts on, a deeper level starts its own, and a paragraph with no number ends the count at its level."""
    count = {}
    out = {}
    for i, p in enumerate(ps):
        ppr = p.find(A('pPr'))
        level = int(ppr.get('lvl', '0')) if ppr is not None else 0
        auto = ppr.find(A('buAutoNum')) if ppr is not None else None
        for deeper in [k for k in count if k > level]:
            del count[deeper]
        if auto is None:
            count.pop(level, None)
            continue
        kind = auto.get('type')
        if auto.get('startAt'):
            n = int(auto.get('startAt'))
        else:
            n = count[level][1] if level in count and count[level][0] == kind else 1
        count[level] = (kind, n + 1)
        out[i] = n
    return out


def hide(src, plan_path, dst):
    with open(plan_path, encoding='utf-8') as f:
        plan = json.load(f)
    with zipfile.ZipFile(src) as z:
        infos = z.infolist()
        raw = {i.filename: z.read(i.filename) for i in infos}
    changed = {}
    for sid, what in plan.items():
        name = slide_part(raw, sid)
        root = etree.fromstring(raw[name], PARSER)
        tree = root.find('.//' + P('spTree'))
        if tree is None:
            raise Fail('slide %s has no shapes' % sid)
        for shape, paras in what.get('paras', []):
            el = shape_by_id(tree, shape)
            body = el.find('.//' + P('txBody')) if el is not None else None
            if body is None:
                raise Fail('slide %s has no text shape %s' % (sid, shape))
            ps = body.findall(A('p'))
            was = numbers(ps)
            for i in paras:
                if not 0 <= i < len(ps):
                    raise Fail('shape %s on slide %s has no paragraph %d' % (shape, sid, i + 1))
                clear_paragraph(ps[i])
            # A numbered paragraph made clear no longer counts: those still seen say the numbers they had.
            if any(i in was for i in paras):
                for i, n in was.items():
                    if i not in paras:
                        ps[i].find(A('pPr')).find(A('buAutoNum')).set('startAt', str(n))
        for shape in what.get('shapes', []):
            el = shape_by_id(tree, shape)
            if el is None:
                raise Fail('slide %s has no shape %s' % (sid, shape))
            el.getparent().remove(el)
        changed[name] = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as out:
        for i in infos:
            out.writestr(i, changed.get(i.filename, raw[i.filename]))


def media(src, sid, shape, dst):
    with zipfile.ZipFile(src) as z:
        names = set(z.namelist())
        raw = {n: z.read(n) for n in names if n.endswith('.xml') or n.endswith('.rels')}
        name = slide_part(raw, sid)
        el = shape_by_id(etree.fromstring(raw[name], PARSER).find('.//' + P('spTree')), shape)
        if el is None:
            raise Fail('slide %s has no shape %s' % (sid, shape))
        rels = rels_of(raw, name)
        # PowerPoint 2010 and later embed the media itself under p14:media; the older a:videoFile may only link it
        ids = [m.get('{%s}embed' % NS_R) for m in el.iter('{%s}media' % NS_P14)]
        ids += [m.get('{%s}link' % NS_R) or m.get('{%s}embed' % NS_R) for t in ('videoFile', 'audioFile', 'quickTimeFile', 'wavAudioFile') for m in el.iter(A(t))]
        for rid in ids:
            got = rels.get(rid)
            if got and not got[1] and got[0] in names:
                with open(dst, 'wb') as f:
                    f.write(z.read(got[0]))
                return
    raise Fail('the media of shape %s on slide %s is not in the deck' % (shape, sid))


def main(argv):
    if len(argv) == 4 and argv[0] == 'hide':
        hide(*argv[1:])
    elif len(argv) == 5 and argv[0] == 'media':
        media(*argv[1:])
    else:
        raise Fail('usage: steps.py hide <in> <plan.json> <out.pptx> | media <in> <slide> <shape> <out>')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as e:
        msg = str(e) if isinstance(e, Fail) else 'the deck could not be read: %s' % (str(e) or type(e).__name__)
        sys.stderr.write(msg.replace('\n', ' ') + '\n')
        sys.exit(1)
`
