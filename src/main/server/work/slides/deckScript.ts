/**
 * The slides pillar's Python tool, run by deck.ts with python-pptx's venv python and -I. A string,
 * not a .py file: the app is bundled, so a file beside this one would not ship. No backticks inside.
 */
export const DECK_PY = String.raw`"""The slides pillar's deck tool (src/main/server/work/slides/deck.ts).

  deck.py inspect <in.pptx> <out.json>
  deck.py apply <in.pptx> <ops.json> <out.pptx> <warnings.json>

inspect writes DeckInfo as JSON. apply runs the edits in order, saves with
python-pptx, then writes the output zip itself so that every part the edits
did not change keeps the input's bytes (python-pptx re-serialises every part
and renames slides to slide1..N on save). On failure: one sentence on
stderr, exit 1.
"""
import copy
import hashlib
import json
import math
import posixpath
import re
import sys
import zipfile

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.oxml.xmlchemy import OxmlElement
from pptx.oxml.ns import qn
from pptx.shapes.picture import Picture

NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
NS_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
NSMAP = {'p': NS_P, 'p14': NS_P14, 'a': 'http://schemas.openxmlformats.org/drawingml/2006/main', 'r': NS_R}
TEXT_CAP = 20000
# XML 1.0 refuses these; \t, \n, \r are allowed, \v is a line break and handled before this.
BAD_XML = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]')
PLACEHOLDER = {
    'title': 'title', 'ctrTitle': 'title', 'subTitle': 'subtitle', 'body': 'body', 'obj': 'body',
    'dt': 'date', 'sldNum': 'number', 'ftr': 'footer', 'hdr': 'header', 'pic': 'picture', 'clipArt': 'picture',
    'chart': 'chart', 'tbl': 'table', 'dgm': 'diagram', 'media': 'media', 'sldImg': 'slideImage',
}
PARSER = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True)
# python-pptx reads every part with blank text between tags dropped, so a part is compared that way:
# pptxgenjs writes a newline inside each empty element, which says nothing.
BLANK = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True, remove_blank_text=True)


def xp(el, path):
    # python-pptx's elements take no namespaces in .xpath(), and its map has no p14
    return etree.XPath(path, namespaces=NSMAP)(el)


class Fail(Exception):
    """An edit that cannot be applied: its message is the sentence the owner reads."""


# ── reading ──────────────────────────────────────────────────────────

def ph_type(shape):
    """The placeholder's type as the XML spells it ('obj' when absent), or None."""
    ph = shape._element.find('.//' + qn('p:nvPr') + '/' + qn('p:ph'))
    return None if ph is None else ph.get('type', 'obj')


# A transform is a 2x3 affine (a, b, c, d, e, f): x' = a*x + c*y + e, y' = b*x + d*y + f, in EMU.
IDENT = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mat(m, n):
    """m after n: the point goes through n first."""
    a, b, c, d, e, f = m
    g, h, i, j, k, l = n
    return (a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f)


def at(m, x, y):
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def about(cx, cy, rot, flip_h, flip_v):
    """A box's own turn: flipped, then rotated clockwise by rot degrees, about its centre (DrawingML's a:xfrm)."""
    r = math.radians(rot)
    co, si = math.cos(r), math.sin(r)
    fx, fy = (-1.0 if flip_h else 1.0), (-1.0 if flip_v else 1.0)
    a, b, c, d = co * fx, si * fx, -si * fy, co * fy
    return (a, b, c, d, cx - a * cx - c * cy, cy - b * cx - d * cy)


def xfrm_of(el):
    """The shape's own a:xfrm (p:xfrm on a graphic frame), or None."""
    if el.tag == qn('p:graphicFrame'):
        return el.find(qn('p:xfrm'))
    pr = el.find(qn('p:grpSpPr')) if el.tag == qn('p:grpSp') else el.find(qn('p:spPr'))
    return None if pr is None else pr.find(qn('a:xfrm'))


def turn_of(x):
    """rot in degrees, flipH, flipV of an xfrm element."""
    if x is None:
        return 0.0, False, False
    try:
        rot = int(x.get('rot', 0)) / 60000.0
    except ValueError:
        rot = 0.0
    return rot, x.get('flipH') in ('1', 'true'), x.get('flipV') in ('1', 'true')


def walk(shapes, xf=IDENT, group=None):
    """Every shape in z-order with the transform to slide space and the outermost group it is in; a group gives its children, not itself."""
    for sh in shapes:
        # by the tag alone: shape_type raises on a p:sp with no geometry, which some exporters write
        if sh._element.tag == qn('p:grpSp'):
            x = xfrm_of(sh._element)
            inner = xf
            if x is not None:
                off, ext, choff, chext = (x.find(qn('a:' + n)) for n in ('off', 'ext', 'chOff', 'chExt'))
                if off is not None and ext is not None and choff is not None and chext is not None:
                    ox, oy, ex, ey = int(off.get('x', 0)), int(off.get('y', 0)), int(ext.get('cx', 0)), int(ext.get('cy', 0))
                    cx, cy = int(chext.get('cx', 0)), int(chext.get('cy', 0))
                    sx = ex / cx if cx else 1
                    sy = ey / cy if cy else 1
                    # child space into the group's box, then the group's own flip and rotation about that box's centre
                    fit = (sx, 0.0, 0.0, sy, ox - int(choff.get('x', 0)) * sx, oy - int(choff.get('y', 0)) * sy)
                    rot, fh, fv = turn_of(x)
                    inner = mat(xf, mat(about(ox + ex / 2.0, oy + ey / 2.0, rot, fh, fv), fit))
            yield from walk(sh.shapes, inner, group if group is not None else sh.shape_id)
        else:
            yield sh, xf, group


def place_of(sh, xf, w, h):
    """Where a shape is drawn: its four corners (top-left, top-right, bottom-right, bottom-left of its own box, turned
    and flipped with it and with every group above it) as shares of the slide, the box around them clamped to the
    slide, and the angle its top edge makes. None when it has no box."""
    try:
        l, t, cw, ch = sh.left, sh.top, sh.width, sh.height
    except Exception:
        return None
    if None in (l, t, cw, ch) or not w or not h:
        return None
    rot, fh, fv = turn_of(xfrm_of(sh._element))
    own = mat(xf, about(l + cw / 2.0, t + ch / 2.0, rot, fh, fv))
    pts = [at(own, x, y) for x, y in ((l, t), (l + cw, t), (l + cw, t + ch), (l, t + ch))]
    quad = [[round(x / w, 5), round(y / h, 5)] for x, y in pts]
    clamp = lambda v: round(min(1.0, max(0.0, v)), 4)
    xs, ys = [q[0] for q in quad], [q[1] for q in quad]
    turned = math.degrees(math.atan2((pts[1][1] - pts[0][1]), (pts[1][0] - pts[0][0])))
    mirrored = (own[0] * own[3] - own[1] * own[2]) < 0
    return {'bbox': [clamp(min(xs)), clamp(min(ys)), clamp(max(xs)), clamp(max(ys))], 'quad': quad, 'rot': round(turned, 2), 'flip': mirrored}


def text_of(tf):
    return '\n'.join(p.text for p in tf.paragraphs)[:TEXT_CAP]


def number(v):
    return v if isinstance(v, (int, float)) and math.isfinite(v) else None


def chart_of(chart):
    try:
        cats = [str(c) for c in chart.plots[0].categories]
        series = [{'name': s.name or '', 'values': [number(v) for v in s.values]} for s in chart.series]
        return {'categories': cats, 'series': series}
    except Exception:
        return None


NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
ALIGN = {'l': 'left', 'ctr': 'center', 'r': 'right', 'just': 'justify', 'dist': 'justify'}
ANCHOR = {'t': 'top', 'ctr': 'middle', 'b': 'bottom'}
INSETS = (('lIns', 91440), ('tIns', 45720), ('rIns', 91440), ('bIns', 45720))
RUN_CAP = 400


def theme_of(prs):
    """The first master's theme: its twelve colours as hex and its heading and body fonts."""
    out = {'colors': {}, 'major': '', 'minor': ''}
    try:
        master = prs.slide_masters[0]
        rel = next(r for r in master.part.rels.values() if r.reltype.endswith('/theme'))
        root = etree.fromstring(rel.target_part.blob, PARSER)
    except Exception:
        return out
    for el in xp(root, './a:themeElements/a:clrScheme/*'):
        c = el.find('{%s}srgbClr' % NS_A)
        if c is not None:
            out['colors'][etree.QName(el).localname] = c.get('val', '').upper()
        else:
            c = el.find('{%s}sysClr' % NS_A)
            if c is not None:
                out['colors'][etree.QName(el).localname] = c.get('lastClr', '').upper()
    for key, path in (('major', './a:themeElements/a:fontScheme/a:majorFont/a:latin'), ('minor', './a:themeElements/a:fontScheme/a:minorFont/a:latin')):
        el = xp(root, path)
        if el:
            out[key] = el[0].get('typeface', '')
    return out


# The names a slide's text uses for the theme's colours, as the master's colour map gives them by default.
CLR_MAP = {'tx1': 'dk1', 'tx2': 'dk2', 'bg1': 'lt1', 'bg2': 'lt2'}


def colour_of(fill, theme):
    """A solid fill's colour as hex, a theme colour resolved by its name; None when it is not a plain colour."""
    if fill is None:
        return None
    c = fill.find('{%s}srgbClr' % NS_A)
    if c is not None:
        return c.get('val', '').upper() or None
    c = fill.find('{%s}schemeClr' % NS_A)
    if c is not None:
        name = c.get('val', '')
        return theme['colors'].get(CLR_MAP.get(name, name))
    return None


def font_of(name, theme):
    if name in ('+mj-lt', '+mj-ea', '+mj-cs'):
        return theme['major']
    if name in ('+mn-lt', '+mn-ea', '+mn-cs'):
        return theme['minor']
    return name


def level_props(lst, level):
    """The a:lvlNpPr of a list style for a level (0 based), or None."""
    return None if lst is None else lst.find('{%s}lvl%dpPr' % (NS_A, level + 1))


def style_chain(sh):
    """The list styles a shape's text takes its look from, nearest first: its own, its layout's and master's
    placeholder of the same kind, the master's title, body or other style, the presentation's default."""
    chain = []
    el = sh._element
    body = el.find(qn('p:txBody'))
    if body is not None:
        chain.append(body.find(qn('a:lstStyle')))
    kind = None
    try:
        slide = sh.part.slide
        pt = ph_type(sh)
        if pt is not None:
            kind = 'title' if pt in ('title', 'ctrTitle') else 'body'
            idx = el.find('.//' + qn('p:nvPr') + '/' + qn('p:ph')).get('idx')
            for holder in (slide.slide_layout, slide.slide_layout.slide_master):
                for cand in holder.placeholders:
                    cph = cand._element.find('.//' + qn('p:nvPr') + '/' + qn('p:ph'))
                    same_kind = cph.get('type', 'obj') == pt or (cph.get('type', 'obj') in ('title', 'ctrTitle') and kind == 'title') or (cph.get('type', 'obj') in ('body', 'obj') and pt in ('body', 'obj', 'subTitle'))
                    if (idx is not None and cph.get('idx') == idx) or (holder is not slide.slide_layout and same_kind) or (idx is None and same_kind):
                        cb = cand._element.find(qn('p:txBody'))
                        if cb is not None:
                            chain.append(cb.find(qn('a:lstStyle')))
                        break
        master = slide.slide_layout.slide_master._element
        styles = master.find(qn('p:txStyles'))
        if styles is not None:
            chain.append(styles.find(qn('p:titleStyle' if kind == 'title' else 'p:bodyStyle' if kind == 'body' else 'p:otherStyle')))
        chain.append(sh.part.package.presentation_part._element.find(qn('p:defaultTextStyle')))
    except Exception:
        pass
    return [c for c in chain if c is not None]


def paragraphs_of(sh, theme):
    """A text shape's paragraphs as runs with the look each is drawn in: what the run says itself, else what its
    paragraph, shape, layout, master and the deck's defaults say, nearest first."""
    body = sh._element.find(qn('p:txBody'))
    if body is None:
        return None
    chain = style_chain(sh)
    bodypr = body.find(qn('a:bodyPr'))
    scale = 1.0
    if bodypr is not None:
        fit = bodypr.find('{%s}normAutofit' % NS_A)
        if fit is not None and fit.get('fontScale'):
            try:
                scale = int(fit.get('fontScale')) / 100000.0
            except ValueError:
                scale = 1.0
    out = []
    count = 0
    for p in body.findall(qn('a:p')):
        ppr = p.find(qn('a:pPr'))
        try:
            level = int(ppr.get('lvl', 0)) if ppr is not None else 0
        except ValueError:
            level = 0
        levels = [lp for lp in (level_props(c, level) for c in chain) if lp is not None]
        defaults = [d for d in (lp.find('{%s}defRPr' % NS_A) for lp in levels) if d is not None]

        def first(attr, own, sources):
            if own is not None and own.get(attr) is not None:
                return own.get(attr)
            for src in sources:
                if src.get(attr) is not None:
                    return src.get(attr)
            return None

        def child(tag, own, sources):
            for src in ([own] if own is not None else []) + list(sources):
                got = src.find('{%s}%s' % (NS_A, tag))
                if got is not None:
                    return got
            return None

        align = first('algn', ppr, levels)
        bullet = 'none'
        for src in ([ppr] if ppr is not None else []) + levels:
            if src.find('{%s}buNone' % NS_A) is not None:
                break
            if src.find('{%s}buChar' % NS_A) is not None:
                bullet = 'bullet'
                break
            if src.find('{%s}buAutoNum' % NS_A) is not None:
                bullet = 'number'
                break
        runs = []
        for r in p:
            tag = etree.QName(r).localname
            if tag not in ('r', 'br', 'fld'):
                continue
            rpr = r.find(qn('a:rPr'))
            text = '\n' if tag == 'br' else ''.join(t.text or '' for t in r.findall(qn('a:t')))
            size = first('sz', rpr, defaults)
            latin = child('latin', rpr, defaults)
            fill = child('solidFill', rpr, defaults)
            run = {'text': text[:TEXT_CAP]}
            if size is not None:
                try:
                    run['size'] = round(int(size) / 100.0 * scale, 1)
                except ValueError:
                    pass
            if latin is not None and latin.get('typeface'):
                run['font'] = font_of(latin.get('typeface'), theme)
            if first('b', rpr, defaults) in ('1', 'true'):
                run['bold'] = True
            if first('i', rpr, defaults) in ('1', 'true'):
                run['italic'] = True
            if (first('u', rpr, defaults) or 'none') != 'none':
                run['underline'] = True
            colour = colour_of(fill, theme)
            if colour:
                run['color'] = colour
            runs.append(run)
            count += 1
            if count >= RUN_CAP:
                break
        out.append({'level': level, 'align': ALIGN.get(align or 'l', 'left'), 'list': bullet, 'runs': runs})
        if count >= RUN_CAP:
            break
    frame = {'anchor': 'top', 'insets': [d for _, d in INSETS], 'fit': 'none', 'wrap': True}
    if bodypr is not None:
        frame['anchor'] = ANCHOR.get(bodypr.get('anchor', 't'), 'top')
        ins = []
        for name, default in INSETS:
            try:
                ins.append(int(bodypr.get(name, default)))
            except ValueError:
                ins.append(default)
        frame['insets'] = ins
        frame['fit'] = 'shrink' if bodypr.find('{%s}normAutofit' % NS_A) is not None else 'grow' if bodypr.find('{%s}spAutoFit' % NS_A) is not None else 'none'
        frame['wrap'] = bodypr.get('wrap', 'square') != 'none'
    return {'paragraphs': out, 'frame': frame}


def shape_info(sh, xf, w, h, group=None, theme=None):
    place = place_of(sh, xf, w, h)
    info = {'id': sh.shape_id, 'name': sh.name, 'kind': 'other', 'bbox': place['bbox'] if place else None, 'text': ''}
    if place:
        info['quad'], info['rot'], info['flip'] = place['quad'], place['rot'], place['flip']
    if group is not None:
        info['group'] = group
    el = sh._element
    pt = ph_type(sh)
    if pt is not None:
        info['placeholder'] = PLACEHOLDER.get(pt, pt)
    if getattr(sh, 'has_table', False):
        info['kind'] = 'table'
        info['cells'] = [[c.text[:TEXT_CAP] for c in row.cells] for row in sh.table.rows]
    elif getattr(sh, 'has_chart', False):
        info['kind'] = 'chart'
        data = chart_of(sh.chart)
        if data is not None:
            info['chart'] = data
    elif el.tag == qn('p:graphicFrame'):
        # a diagram, an embedded object: drawn, kept, and edited in PowerPoint
        info['kind'] = 'frame'
    elif el.tag == qn('p:cxnSp'):
        info['kind'] = 'connector'
    elif el.tag == qn('p:pic'):
        nv = el.find('.//' + qn('p:nvPr'))
        media = nv is not None and (nv.find('{%s}videoFile' % NS_A) is not None or nv.find('{%s}audioFile' % NS_A) is not None)
        info['kind'] = 'media' if media else 'picture'
        if media:
            info['media'] = 'audio' if nv.find('{%s}audioFile' % NS_A) is not None else 'video'
    elif isinstance(sh, Picture):
        info['kind'] = 'picture'
    elif sh.has_text_frame:
        info['text'] = text_of(sh.text_frame)
        # A decorative shape carries an empty txBody too: only words or a placeholder make it a text shape.
        if info['text'] or pt is not None:
            info['kind'] = 'text'
            if theme is not None:
                try:
                    look = paragraphs_of(sh, theme)
                except Exception:
                    look = None
                if look is not None:
                    info['paragraphs'], info['frame'] = look['paragraphs'], look['frame']
    if el.tag == qn('p:sp'):
        geom = el.find(qn('p:spPr') + '/' + '{%s}prstGeom' % NS_A)
        drawn = el.find(qn('p:spPr') + '/' + '{%s}custGeom' % NS_A)
        # a placeholder that names no outline takes its layout's, which is a plain box in every deck we draw
        info['shape'] = geom.get('prst', 'rect') if geom is not None else 'custom' if drawn is not None else 'rect'
    return info


TRANSITION_MS = {'fast': 500, 'med': 750, 'slow': 1000}
NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'


def transition_of(slide):
    """The slide's own transition: its kind as the file names it, its direction, how long, and the seconds after
    which it moves on by itself. None when the slide has none."""
    el = slide._element.find(qn('p:transition'))
    if el is None:
        # PowerPoint 2010 and later wrap it: the choice it would take, else the fallback
        for path in ('./mc:AlternateContent/mc:Choice/p:transition', './mc:AlternateContent/mc:Fallback/p:transition'):
            got = etree.XPath(path, namespaces={'mc': NS_MC, 'p': NS_P})(slide._element)
            if got:
                el = got[0]
                break
    if el is None:
        return None
    kind, direction = 'none', None
    for c in el:
        name = etree.QName(c).localname
        if name in ('extLst', 'sndAc'):
            continue
        kind = name
        direction = c.get('dir')
        break
    out = {'kind': kind}
    if direction:
        out['dir'] = direction
    dur = el.get('{%s}dur' % NS_P14)
    try:
        out['ms'] = int(dur) if dur else TRANSITION_MS.get(el.get('spd', 'fast'), 500)
    except ValueError:
        out['ms'] = 500
    if el.get('advTm') is not None:
        try:
            out['after'] = int(el.get('advTm'))
        except ValueError:
            pass
    if el.get('advClick') in ('0', 'false'):
        out['click'] = False
    return out


def layouts_of(prs):
    """Each layout a slide can take: its name, its master's place, and the placeholders it holds by kind and index."""
    out = []
    for mi, m in enumerate(prs.slide_masters):
        for l in m.slide_layouts:
            holds = []
            for ph in l.placeholders:
                el = ph._element.find('.//' + qn('p:nvPr') + '/' + qn('p:ph'))
                if el is None:
                    continue
                kind = el.get('type', 'obj')
                holds.append({'kind': PLACEHOLDER.get(kind, kind), 'idx': int(el.get('idx', 0))})
            out.append({'name': l.name, 'master': mi, 'holds': holds})
    return out


def sections_of(prs):
    out = []
    for sec in xp(prs.part._element, './p:extLst/p:ext/p14:sectionLst/p14:section'):
        ids = [int(s.get('id')) for s in xp(sec, './p14:sldIdLst/p14:sldId')]
        out.append({'name': sec.get('name', ''), 'slideIds': ids})
    return out


def layout_names(prs):
    names = []
    for m in prs.slide_masters:
        for l in m.slide_layouts:
            if l.name not in names:
                names.append(l.name)
    return names


def deck_draws(raw):
    """What every slide's picture takes from the deck itself: the presentation's own settings (the slide size, the
    number slides count from, the default text style, embedded fonts) but not its list of slides, and the table
    styles and fonts it names. A change here draws every slide again."""
    h = hashlib.sha256()
    main = next((target for _, ty, target, mode in rels_of(raw, '') if ty.endswith('/officeDocument') and mode != 'External'), None)
    if main is None or main not in raw:
        return h.digest()
    try:
        root = etree.fromstring(raw[main], BLANK)
        h.update(repr(sorted(root.attrib.items())).encode('utf-8'))
        for tag in ('sldSz', 'defaultTextStyle', 'embeddedFontLst'):
            for el in root.findall('{%s}%s' % (NS_P, tag)):
                # exclusive: only the namespaces the element itself uses, so what the root declares says nothing here
                h.update(etree.tostring(el, method='c14n', exclusive=True))
    except etree.XMLSyntaxError:
        h.update(raw[main])
    # By their bytes alone, in an order a save cannot change.
    for digest in sorted(hashlib.sha256(raw[target]).digest() for _, ty, target, mode in rels_of(raw, main) if mode != 'External' and (ty.endswith('/tableStyles') or ty.endswith('/font')) and target in raw):
        h.update(digest)
    return h.digest()


def draws_of(raw, part, number, deck=b''):
    """One hash of everything a slide's picture is drawn from: its own XML and every part it reaches through
    relationships (its layout, that layout's master and theme, its pictures, charts and media), but not its notes
    and not other slides; by their bytes alone, since a save renames parts; and what it takes from the deck itself
    (deck_draws). Its number in the deck goes in when the slide, its layout or its master prints one. Equal across
    two versions of a deck means the same picture. None for a slide whose part is not in the file: it has no
    picture of its own to keep."""
    if part not in raw:
        return None
    seen = []
    queue = [part]
    while queue:
        name = queue.pop()
        if name in seen or name not in raw:
            continue
        seen.append(name)
        for _, ty, target, mode in rels_of(raw, name):
            if mode == 'External' or ty.endswith('/notesSlide') or ty.endswith('/slide'):
                continue
            queue.append(target)
    h = hashlib.sha256()
    h.update(deck)
    for digest in sorted(hashlib.sha256(raw[name]).digest() for name in seen):
        h.update(digest)
    numbered = [n for n in seen if n == part or '/slideLayouts/' in n or '/slideMasters/' in n]
    if any(b'type="slidenum"' in raw[n] for n in numbered):
        h.update(b'#%d' % number)
    return h.hexdigest()


def inspect(src, out):
    prs = Presentation(src)
    with zipfile.ZipFile(src) as z:
        raw = {n: z.read(n) for n in z.namelist()}
    # By id through the file's own rels: python-pptx renames slide parts to deck order the first
    # time .slides is read, so slide.part.partname is not the part's name in the file.
    parts = {sid: part for sid, (part, _) in slide_parts(raw).items()}
    w, h = prs.slide_width or 0, prs.slide_height or 0
    theme = theme_of(prs)
    deck = deck_draws(raw)
    slides = []
    for slide in prs.slides:
        flat = list(walk(slide.shapes))
        shapes = [shape_info(sh, xf, w, h, group, theme) for sh, xf, group in flat]
        title = ''
        t = next((s for s in shapes if s.get('placeholder') == 'title' and s['kind'] == 'text'), None)
        if t is not None and t['text']:
            title = t['text']
        else:
            first = next((s for s in shapes if s['kind'] == 'text' and s['text']), None)
            title = first['text'].split('\n')[0] if first else ''
        notes = ''
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
            notes = text_of(slide.notes_slide.notes_text_frame)
        slides.append({
            'id': slide.slide_id,
            'hidden': slide._element.get('show') in ('0', 'false'),
            'layout': slide.slide_layout.name,
            'title': title[:TEXT_CAP],
            'notes': notes,
            'hash': hashlib.sha256(raw.get(parts.get(slide.slide_id, ''), b'')).hexdigest(),
            **({'draws': d} if (d := draws_of(raw, parts.get(slide.slide_id, ''), len(slides) + 1, deck)) is not None else {}),
            'shapes': shapes,
            **({'transition': tr} if (tr := transition_of(slide)) is not None else {}),
        })
    info = {'width': w, 'height': h, 'slides': slides, 'sections': sections_of(prs), 'layouts': layout_names(prs), 'layoutInfo': layouts_of(prs), 'theme': theme}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(info, f)


# ── editing ──────────────────────────────────────────────────────────

def clean(s):
    return BAD_XML.sub('', s)


def as_rpr(el):
    """An a:rPr copy of a run's rPr, or of a paragraph's endParaRPr when it has no run."""
    r = OxmlElement('a:rPr')
    for k, v in el.attrib.items():
        r.set(k, v)
    for child in el:
        r.append(copy.deepcopy(child))
    return r


def set_paragraph(p, text):
    """One paragraph's words, keeping its pPr and its first run's rPr (python-pptx's .text setter drops them)."""
    first = p.find(qn('a:r') + '/' + qn('a:rPr'))
    end = p.find(qn('a:endParaRPr'))
    rpr = copy.deepcopy(first) if first is not None else (as_rpr(end) if end is not None else None)
    for child in list(p):
        if child.tag in (qn('a:r'), qn('a:br'), qn('a:fld')):
            p.remove(child)
    lines = re.split('[\n\v]', text)
    made = []
    for i, line in enumerate(lines):
        if i:
            br = OxmlElement('a:br')
            if rpr is not None:
                br.append(copy.deepcopy(rpr))
            made.append(br)
        if line or len(lines) == 1:
            r = OxmlElement('a:r')
            if rpr is not None:
                r.append(copy.deepcopy(rpr))
            t = OxmlElement('a:t')
            t.text = clean(line)
            r.append(t)
            made.append(r)
    for el in made:
        if end is not None:
            end.addprevious(el)
        else:
            p.append(el)


def set_paragraphs(txBody, paragraphs):
    """Paragraph i takes paragraph i's look; extra ones copy the last; surplus ones go."""
    ps = txBody.findall(qn('a:p'))
    if not ps:
        txBody.append(OxmlElement('a:p'))
        ps = txBody.findall(qn('a:p'))
    for i, text in enumerate(paragraphs):
        if i < len(ps):
            set_paragraph(ps[i], text)
        else:
            p = copy.deepcopy(ps[-1])
            set_paragraph(p, text)
            txBody.findall(qn('a:p'))[-1].addnext(p)
    for p in ps[len(paragraphs):]:
        txBody.remove(p)


def slide_by_id(prs, sid):
    for el in prs.slides._sldIdLst:
        if el.id == sid:
            return prs.part.related_slide(el.rId), el
    raise Fail('there is no slide %d' % sid)


def shape_on(slide, sid, ref):
    found = [sh for sh, _, _ in walk(slide.shapes) if (sh.shape_id == ref if isinstance(ref, int) else sh.name == ref)]
    if not found:
        raise Fail('slide %d has no shape %s' % (sid, ('%d' % ref) if isinstance(ref, int) else 'named ' + ref))
    if len(found) > 1:
        raise Fail('slide %d has %d shapes named %s; name it by its id instead' % (sid, len(found), ref))
    return found[0]


def section_list(prs):
    lst = xp(prs.part._element, './p:extLst/p:ext/p14:sectionLst')
    return lst[0] if lst else None


def section_drop(prs, sid):
    lst = section_list(prs)
    if lst is None:
        return
    for el in xp(lst, './p14:section/p14:sldIdLst/p14:sldId[@id="%d"]' % sid):
        el.getparent().remove(el)


def section_place(prs, sid, after):
    """Puts a slide's id in its section, after 'after' (0: the first section's start): PowerPoint repairs a deck whose sections miss a slide."""
    lst = section_list(prs)
    if lst is None:
        return
    el = etree.SubElement(etree.Element('x'), '{%s}sldId' % NS_P14)
    el.set('id', str(sid))
    if after:
        hit = xp(lst, './p14:section/p14:sldIdLst/p14:sldId[@id="%d"]' % after)
        if hit:
            hit[0].addnext(el)
            return
    first = xp(lst, './p14:section/p14:sldIdLst')
    if first:
        first[0].insert(0, el)


def place_after(prs, el, after):
    ids = prs.slides._sldIdLst
    ids.remove(el)
    if after == 0:
        ids.insert(0, el)
        return
    for i, other in enumerate(ids):
        if other.id == after:
            ids.insert(i + 1, el)
            return


def check_after(prs, after, what):
    if after and not any(e.id == after for e in prs.slides._sldIdLst):
        raise Fail('there is no slide %d to put %s after' % (after, what))


def op_text(prs, op):
    slide, _ = slide_by_id(prs, op['slide'])
    sh = shape_on(slide, op['slide'], op['shape'])
    if not sh.has_text_frame:
        raise Fail('shape %s on slide %d holds no text' % (sh.name, op['slide']))
    set_paragraphs(sh.text_frame._txBody, op['paragraphs'])


def op_cell(prs, op):
    slide, _ = slide_by_id(prs, op['slide'])
    sh = shape_on(slide, op['slide'], op['shape'])
    if not getattr(sh, 'has_table', False):
        raise Fail('shape %s on slide %d is not a table' % (sh.name, op['slide']))
    t = sh.table
    if op['row'] >= len(t.rows) or op['col'] >= len(t.columns):
        raise Fail('the table %s on slide %d has %d rows and %d columns; there is no cell %d, %d' % (sh.name, op['slide'], len(t.rows), len(t.columns), op['row'], op['col']))
    set_paragraphs(t.cell(op['row'], op['col']).text_frame._txBody, op['text'].split('\n'))


def op_notes(prs, op):
    slide, _ = slide_by_id(prs, op['slide'])
    tf = slide.notes_slide.notes_text_frame
    if tf is None:
        raise Fail('the notes page of slide %d has no place for words' % op['slide'])
    set_paragraphs(tf._txBody, op['text'].split('\n'))


def op_chart(prs, op):
    slide, _ = slide_by_id(prs, op['slide'])
    sh = shape_on(slide, op['slide'], op['shape'])
    if not getattr(sh, 'has_chart', False):
        raise Fail('shape %s on slide %d is not a chart' % (sh.name, op['slide']))
    chart = sh.chart
    kind = type(chart.plots[0]).__name__ if len(chart.plots) else ''
    if kind in ('XyPlot', 'BubblePlot'):
        raise Fail('the chart %s on slide %d plots x against y; only a chart by category takes new data' % (sh.name, op['slide']))
    n = len(op['categories'])
    for s in op['series']:
        if len(s['values']) != n:
            raise Fail('series %s has %d values for %d categories' % (s['name'], len(s['values']), n))
    data = CategoryChartData()
    data.categories = op['categories']
    for s in op['series']:
        data.add_series(s['name'], s['values'])
    chart.replace_data(data)


def op_add(prs, op):
    layout = next((l for m in prs.slide_masters for l in m.slide_layouts if l.name == op['layout']), None)
    if layout is None:
        raise Fail('the deck has no layout named %s; its layouts are %s' % (op['layout'], ', '.join(layout_names(prs))))
    check_after(prs, op['after'], 'the new slide')
    sid = op.get('id')
    if sid is not None:
        if sid < 256 or sid > 2147483647:
            raise Fail('a slide id is from 256 to 2147483647, not %d' % sid)
        if any(e.id == sid for e in prs.slides._sldIdLst):
            raise Fail('the deck already has a slide %d' % sid)
    phs = [(ph_type(p), p) for p in layout.placeholders]
    if op.get('title') is not None and not any(t in ('title', 'ctrTitle') for t, _ in phs):
        raise Fail('the layout %s has no title placeholder' % op['layout'])
    if op.get('body') and not any(t in ('body', 'obj', 'subTitle') for t, _ in phs):
        raise Fail('the layout %s has no body placeholder' % op['layout'])

    # python-pptx names a new slide part by the count of slides, and renames the parts to deck
    # order only the first time .slides is read: after a remove, a second add would take a name a
    # slide still holds, and one would overwrite the other in the zip. Name them in order first.
    prs.part.rename_slide_parts([e.rId for e in prs.slides._sldIdLst])
    slide = prs.slides.add_slide(layout)
    el = prs.slides._sldIdLst[-1]
    if sid is not None:
        el.set('id', str(sid))
    used = set()
    placed = [(ph_type(p), p) for p in slide.placeholders]
    if op.get('title') is not None:
        ph = next(p for t, p in placed if t in ('title', 'ctrTitle'))
        set_paragraphs(ph.text_frame._txBody, [op['title']])
        used.add(ph.shape_id)
    if op.get('body'):
        # the first body or content placeholder; a title layout's subtitle when it has neither
        ph = next((p for t, p in placed if t in ('body', 'obj')), None) or next(p for t, p in placed if t == 'subTitle')
        set_paragraphs(ph.text_frame._txBody, op['body'])
        used.add(ph.shape_id)
    # PowerPoint shows an empty placeholder as "Click to add text" in edit view.
    for _, p in placed:
        if p.shape_id not in used:
            p._element.getparent().remove(p._element)
    if op.get('notes'):
        set_paragraphs(slide.notes_slide.notes_text_frame._txBody, op['notes'].split('\n'))
    place_after(prs, el, op['after'])
    section_place(prs, el.id, op['after'])


# What may point at a slide and go with it: a jump link on a shape or a run.
LINK_TAGS = {qn('a:hlinkClick'), qn('a:hlinkHover')}
# Things an edit has to tell the agent that are not failures (a link it took out): "note: edit N: ...".
NOTES = []


def refs_to(part, rid):
    """The elements of a part's XML that name the relationship rid."""
    return [el for el in part._element.iter('*') if any(k.startswith('{%s}' % NS_R) and v == rid for k, v in el.attrib.items())]


def op_remove(prs, op):
    slide, el = slide_by_id(prs, op['slide'])
    if len(prs.slides._sldIdLst) == 1:
        raise Fail('slide %d is the deck\'s only slide' % op['slide'])
    target = slide.part
    notes = slide.part.notes_slide if slide.has_notes_slide else None
    gone = {id(target)} | ({id(notes.part)} if notes is not None else set())
    names = {id(s.part): 'slide %d' % s.slide_id for s in prs.slides}
    # Every other part that points at the slide lets go of it: a part still reachable is saved under its
    # old name, and the next rename to deck order gives that name to a second slide. Only a jump link may
    # point at it; anything else is refused before anything changes.
    drops = []
    for part in list(prs.part.package.iter_parts()):
        if id(part) in gone or part is prs.part or not hasattr(part, '_element'):
            continue
        for rid, rel in list(part.rels.items()):
            if rel.is_external or rel.target_part is not target:
                continue
            refs = refs_to(part, rid)
            other = [e for e in refs if e.tag not in LINK_TAGS]
            where = names.get(id(part), str(part.partname))
            if other:
                raise Fail('%s refers to slide %d in its %s, which is not a link; nothing was removed' % (where, op['slide'], etree.QName(other[0]).localname))
            drops.append((part, rid, refs, where))
    for part, rid, refs, where in drops:
        for e in refs:
            e.getparent().remove(e)
        part.drop_rel(rid)
        NOTES.append('%s linked to slide %d; that link was taken out' % (where, op['slide']))
    rid = el.rId
    prs.slides._sldIdLst.remove(el)
    # A custom show names the slide by the same rel: it leaves the show, else presentation.xml keeps a dangling r:id.
    for sld in xp(prs.part._element, './p:custShowLst/p:custShow/p:sldLst/p:sld'):
        if sld.get('{%s}id' % NS_R) == rid:
            sld.getparent().remove(sld)
    # With no rel left, the slide part (and its notes) is not reachable, so python-pptx does not save it.
    prs.part.drop_rel(rid)
    section_drop(prs, op['slide'])


def op_move(prs, op):
    _, el = slide_by_id(prs, op['slide'])
    if op['after'] == op['slide']:
        raise Fail('slide %d cannot go after itself' % op['slide'])
    check_after(prs, op['after'], 'slide %d' % op['slide'])
    place_after(prs, el, op['after'])
    section_drop(prs, op['slide'])
    section_place(prs, op['slide'], op['after'])


OPS = {'text': op_text, 'cell': op_cell, 'notes': op_notes, 'chart': op_chart, 'add': op_add, 'remove': op_remove, 'move': op_move}


# ── the byte rule ────────────────────────────────────────────────────

def rels_path(part):
    d, n = posixpath.split(part)
    return posixpath.join(d, '_rels', n + '.rels')


def rels_of(raw, part):
    """(Id, Type, resolved target, TargetMode) of a part's rels."""
    data = raw.get(rels_path(part))
    if data is None:
        return []
    base = posixpath.dirname(part)
    out = []
    for r in etree.fromstring(data, PARSER).findall('{%s}Relationship' % NS_RELS):
        mode = r.get('TargetMode', 'Internal')
        target = r.get('Target', '')
        if mode != 'External':
            target = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(base, target))
        out.append((r.get('Id'), r.get('Type', ''), target, mode))
    return out


def slide_parts(raw):
    """{slide id: (slide part, notes part or None)} through presentation.xml and its rels."""
    main = next((t for _, ty, t, _ in rels_of(raw, '') if ty.endswith('/officeDocument')), 'ppt/presentation.xml')
    targets = {rid: t for rid, _, t, _ in rels_of(raw, main)}
    out = {}
    for el in etree.fromstring(raw[main], PARSER).iter('{%s}sldId' % NS_P):
        part = targets.get(el.get('{%s}id' % NS_R))
        if part is None:
            continue
        notes = next((t for _, ty, t, _ in rels_of(raw, part) if ty.endswith('/notesSlide')), None)
        out[int(el.get('id'))] = (part, notes)
    return out


def c14n(data):
    return etree.tostring(etree.fromstring(data, BLANK), method='c14n2')


def content_types(data):
    root = etree.fromstring(data, PARSER)
    d = {('D', e.get('Extension', '').lower(), e.get('ContentType')) for e in root.findall('{%s}Default' % NS_CT)}
    o = {('O', e.get('PartName', '').lower(), e.get('ContentType')) for e in root.findall('{%s}Override' % NS_CT)}
    return d | o


def same(name, new, old, new_raw, old_raw, new_src, old_src):
    if new == old:
        return True
    try:
        if name == '[Content_Types].xml':
            return content_types(new) == content_types(old)
        if name.endswith('.rels'):
            # equal by what they say, resolved: a target named another way is the same target
            return set(rels_of(new_raw, new_src)) == set(rels_of(old_raw, old_src))
        if new.lstrip()[:1] == b'<':
            return c14n(new) == c14n(old)
    except etree.XMLSyntaxError:
        return False
    return False


def rels_source(name):
    """The part a .rels file belongs to ('' for the package's own)."""
    d, n = posixpath.split(name)
    return posixpath.join(posixpath.dirname(d), n[:-len('.rels')]) if n != '.rels' else ''


def finish(src, saved, dst):
    with zipfile.ZipFile(src) as z:
        old_info = {i.filename: i for i in z.infolist()}
        old_order = [i.filename for i in z.infolist()]
        old_raw = {n: z.read(n) for n in old_order}
    with zipfile.ZipFile(saved) as z:
        new_order = [i.filename for i in z.infolist()]
        new_raw = {n: z.read(n) for n in new_order}

    old_slides, new_slides = slide_parts(old_raw), slide_parts(new_raw)
    # Slides and their notes pair by slide id, never by name: the save renamed them.
    by_id = {p for pair in list(old_slides.values()) + list(new_slides.values()) for p in pair if p}
    pair = {}
    for sid, (part, notes) in new_slides.items():
        if sid in old_slides:
            pair[part] = old_slides[sid][0]
            if notes and old_slides[sid][1]:
                pair[notes] = old_slides[sid][1]

    def partner(name):
        if name.endswith('.rels'):
            src_part = rels_source(name)
            if src_part in by_id:
                other = pair.get(src_part)
                return (rels_path(other) if other else None), src_part, other
            return (name if name in old_raw else None), src_part, src_part
        if name in by_id:
            return pair.get(name), None, None
        return (name if name in old_raw else None), None, None

    entries = []
    for name in new_order:
        old, new_src, old_src = partner(name)
        data, info = new_raw[name], None
        if old is not None and old in old_raw and same(name, data, old_raw[old], new_raw, old_raw, new_src, old_src):
            data, info = old_raw[old], old_info[old]
        rank = old_order.index(old) if old in old_info else len(old_order) + new_order.index(name)
        if name == '[Content_Types].xml':
            rank = -1
        entries.append((rank, name, data, info))
    entries.sort(key=lambda e: e[0])
    # A name twice is a corrupt deck (the second entry hides the first): never written over his file.
    seen = set()
    for _, name, _, _ in entries:
        if name in seen:
            raise Fail('the edits would write the deck with two parts named %s, so nothing was written' % name)
        seen.add(name)
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
        for _, name, data, info in entries:
            zi = zipfile.ZipInfo(name, info.date_time if info else (1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            if info:
                zi.external_attr = info.external_attr
            z.writestr(zi, data)


def apply(src, ops_path, dst, warnings_path):
    with open(ops_path, encoding='utf-8') as f:
        ops = json.load(f)
    prs = Presentation(src)
    warnings = []
    for i, op in enumerate(ops, 1):
        try:
            fn = OPS.get(op.get('op'))
            if fn is None:
                raise Fail('%s is not an edit' % op.get('op'))
            NOTES.clear()
            fn(prs, op)
            warnings.extend('note: edit %d: %s' % (i, n) for n in NOTES)
        except Fail as e:
            warnings.append('edit %d: %s' % (i, e))
        except Exception as e:  # python-pptx's own: the edit is reported, the others still run
            warnings.append('edit %d: could not be applied (%s)' % (i, str(e) or type(e).__name__))
    saved = dst + '.saved'
    prs.save(saved)
    finish(src, saved, dst)
    with open(warnings_path, 'w', encoding='utf-8') as f:
        json.dump(warnings, f)


def main(argv):
    if len(argv) == 3 and argv[0] == 'inspect':
        inspect(argv[1], argv[2])
    elif len(argv) == 5 and argv[0] == 'apply':
        apply(*argv[1:])
    else:
        raise Fail('usage: deck.py inspect <in> <out.json> | apply <in> <ops.json> <out.pptx> <warnings.json>')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as e:
        msg = str(e) if isinstance(e, Fail) else 'the deck could not be read or written: %s' % (str(e) or type(e).__name__)
        sys.stderr.write(msg.replace('\n', ' ') + '\n')
        sys.exit(1)
`
