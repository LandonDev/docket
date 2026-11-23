/**
 * The slides pillar's Python tool, run by deck.ts with python-pptx's venv python and -I. A string,
 * not a .py file: the app is bundled, so a file beside this one would not ship. No backticks inside.
 */
export const DECK_PY = String.raw`"""The slides pillar's deck tool (src/main/server/work/slides/deck.ts).

  deck.py inspect <in.pptx> <out.json>
  deck.py apply <in.pptx> <ops.json> <out.pptx> <warnings.json>
  deck.py pack <from.pptx> <to.pptx> <out.pack>
  deck.py unpack <now.pptx> <in.pack> <out.pptx>
  deck.py layouts <in.pptx> <out.pptx>
  deck.py step <in.pptx> <ops.json> <out.pptx> <warnings.json> <back.pack> <info.json>
  deck.py unstep <now.pptx> <in.pack> <out.pptx> <back.pack> <info.json>

inspect writes DeckInfo as JSON. apply runs the edits in order, saves with
python-pptx, then writes the output zip itself so that every part the edits
did not change keeps the input's bytes (python-pptx re-serialises every part
and renames slides to slide1..N on save). pack writes what turns the second
deck back into the first: the first's parts that the second changed or lost,
and the names it added. unpack applies one to the deck it was made against.
layouts writes a deck of one slide per layout of the input, each placeholder
saying what it is, for the layout picker's pictures. step and unstep are one of his own edits, and one taken back or put back, in
one run: the deck after, the pack that reverses it, and the new deck's
DeckInfo, so the host starts Python once for an edit. On failure: one
sentence on stderr, exit 1.
"""
import copy
import hashlib
import json
import math
import os
import posixpath
import re
import sys
import uuid
import zipfile

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.enum.shapes import MSO_SHAPE
from pptx.opc.packuri import PackURI
from pptx.oxml.xmlchemy import OxmlElement
from pptx.oxml.ns import qn
from pptx.shapes.picture import Picture
from pptx.util import Emu

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


def own_of(sh, xf):
    """A shape's own box as it lies on the slide before any turn, in EMU, with its own turn and flips: what a
    geometry edit takes. None for a shape in a group that is turned or flipped (its numbers are not the slide's)."""
    try:
        l, t, cw, ch = sh.left, sh.top, sh.width, sh.height
    except Exception:
        return None
    if None in (l, t, cw, ch) or abs(xf[1]) > 1e-9 or abs(xf[2]) > 1e-9 or xf[0] <= 0 or xf[3] <= 0:
        return None
    rot, fh, fv = turn_of(xfrm_of(sh._element))
    return {'box': [int(round(xf[0] * l + xf[4])), int(round(xf[3] * t + xf[5])), int(round(xf[0] * cw)), int(round(xf[3] * ch))], 'rot': round(rot % 360, 2), 'flipH': fh, 'flipV': fv}


def paint_of(el, theme):
    """A shape's own fill and outline where it says them itself: a colour as hex, 'none', and the line's weight in
    points and dash. What it leaves to its style or theme is not said."""
    out = {}
    sppr = el.find(qn('p:spPr'))
    if sppr is None:
        return out
    if sppr.find('{%s}noFill' % NS_A) is not None:
        out['fill'] = 'none'
    else:
        colour = colour_of(sppr.find('{%s}solidFill' % NS_A), theme) if theme is not None else None
        if colour:
            out['fill'] = colour
    ln = sppr.find('{%s}ln' % NS_A)
    if ln is not None:
        line = {}
        if ln.find('{%s}noFill' % NS_A) is not None:
            line['color'] = 'none'
        else:
            colour = colour_of(ln.find('{%s}solidFill' % NS_A), theme) if theme is not None else None
            if colour:
                line['color'] = colour
        try:
            if ln.get('w') is not None:
                line['width'] = round(int(ln.get('w')) / 12700.0, 2)
        except ValueError:
            pass
        dash = ln.find('{%s}prstDash' % NS_A)
        if dash is not None and dash.get('val'):
            line['dash'] = dash.get('val')
        if line:
            out['line'] = line
    return out


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
    own = own_of(sh, xf)
    if own is not None:
        info['own'] = own
    paint = paint_of(el, theme)
    if paint:
        info.update(paint)
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
        # Its paragraphs and frame are said either way: a drawn shape with no words can still be typed into.
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


TIMING_CAP = 4000


def timing_of(slide):
    """The slide's p:timing as a plain tree, each element its name, attributes, children and text, for the host to
    read builds from (steps.ts). None when the slide has none; past TIMING_CAP elements only {'over': True}."""
    el = slide._element.find(qn('p:timing'))
    if el is None:
        return None
    seen = [0]

    def node(e):
        seen[0] += 1
        if seen[0] > TIMING_CAP:
            raise OverflowError()
        out = {'t': etree.QName(e).localname}
        if e.attrib:
            out['a'] = {etree.QName(k).localname: v for k, v in e.attrib.items()}
        kids = [node(c) for c in e if isinstance(c.tag, str)]
        if kids:
            out['c'] = kids
        if e.text and e.text.strip():
            out['x'] = e.text.strip()[:200]
        return out
    try:
        return node(el)
    except OverflowError:
        return {'t': 'timing', 'over': True}


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


def layouts_draws(raw, deck=b''):
    """One hash of everything the deck's layouts are drawn from: its masters, their layouts and themes and what
    those hold, and the deck's own settings; no slide. Equal across two versions of a deck means the layout
    picker's pictures are the same."""
    main = next((target for _, ty, target, mode in rels_of(raw, '') if ty.endswith('/officeDocument') and mode != 'External'), None)
    if main is None or main not in raw:
        return None
    seen = []
    queue = [target for _, ty, target, mode in rels_of(raw, main) if mode != 'External' and ty.endswith('/slideMaster')]
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
    return h.hexdigest()


def layouts_deck(src, dst):
    """A deck of one slide per layout of the input, in the order the outline lists them: every slide of the input
    gone, each layout's title saying the layout's name and its text places saying what they are, so its picture
    shows where things go and in what type."""
    prs = Presentation(src)
    for el in list(prs.slides._sldIdLst):
        rid = el.rId
        prs.slides._sldIdLst.remove(el)
        prs.part.drop_rel(rid)
    pres = prs.part._element
    # what named the slides that are gone: the sections, the custom shows
    lst = section_list(prs)
    if lst is not None:
        ext = lst.getparent()
        holder = ext.getparent()
        holder.remove(ext)
        if len(holder) == 0:
            holder.getparent().remove(holder)
    for shows in xp(pres, './p:custShowLst'):
        pres.remove(shows)
    for m in prs.slide_masters:
        for l in m.slide_layouts:
            slide = prs.slides.add_slide(l)
            for ph in list(slide.placeholders):
                t = ph_type(ph)
                words = l.name if t in ('title', 'ctrTitle') else 'Subtitle' if t == 'subTitle' else 'Text' if t in ('body', 'obj') else None
                if words is None or not ph.has_text_frame:
                    ph._element.getparent().remove(ph._element)
                else:
                    set_paragraphs(ph.text_frame._txBody, [words])
    prs.save(dst)


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
        # The layouts this slide may be given (op_layout's own test), by name.
        mine = holds_of(slide)
        fits = [l.name for m in prs.slide_masters for l in m.slide_layouts if l.part is slide.slide_layout.part or all(held.get(i) == k for i, k in mine.items() for held in (holds_of(l),))]
        slides.append({
            'fits': fits,
            'id': slide.slide_id,
            'hidden': slide._element.get('show') in ('0', 'false'),
            'layout': slide.slide_layout.name,
            'title': title[:TEXT_CAP],
            'notes': notes,
            'hash': hashlib.sha256(raw.get(parts.get(slide.slide_id, ''), b'')).hexdigest(),
            **({'draws': d} if (d := draws_of(raw, parts.get(slide.slide_id, ''), len(slides) + 1, deck)) is not None else {}),
            'shapes': shapes,
            **({'transition': tr} if (tr := transition_of(slide)) is not None else {}),
            **({'timing': tm} if (tm := timing_of(slide)) is not None else {}),
        })
    info = {'width': w, 'height': h, 'slides': slides, 'sections': sections_of(prs), 'layouts': layout_names(prs), 'layoutInfo': layouts_of(prs), 'theme': theme}
    looks = layouts_draws(raw, deck)
    if looks is not None:
        info['layoutsDraws'] = looks
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


# ── his own edits: runs and their look ───────────────────────────────

# The order the schema wants an a:rPr's and an a:pPr's children in. PowerPoint 16 opened one out of order with no word
# (the VM proof); the schema's order is still what a stricter reader expects, so that is what is written.
RPR_ORDER = ['ln', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'effectLst', 'effectDag', 'highlight',
             'uLnTx', 'uLn', 'uFillTx', 'uFill', 'latin', 'ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst']
PPR_ORDER = ['lnSpc', 'spcBef', 'spcAft', 'buClrTx', 'buClr', 'buSzTx', 'buSzPct', 'buSzPts', 'buFontTx', 'buFont',
             'buNone', 'buAutoNum', 'buChar', 'buBlip', 'tabLst', 'defRPr', 'extLst']
FILLS = ('noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill')
BULLETS = ('buNone', 'buAutoNum', 'buChar', 'buBlip')
ALGN = {'left': 'l', 'center': 'ctr', 'right': 'r', 'justify': 'just'}
LOOK = ('bold', 'italic', 'underline', 'size', 'font', 'color')
PARA = ('level', 'align', 'list')
RUN_TAGS = (qn('a:r'), qn('a:br'), qn('a:fld'))


def put(parent, el, order, drop=()):
    """Puts el among parent's children where the schema wants it, in place of any of its own kind and of 'drop'."""
    name = etree.QName(el).localname
    for c in list(parent):
        if etree.QName(c).localname in (name,) + tuple(drop):
            parent.remove(c)
    at = order.index(name)
    for i, c in enumerate(parent):
        cn = etree.QName(c).localname
        if cn in order and order.index(cn) > at:
            parent.insert(i, el)
            return
    parent.append(el)


def set_look(rpr, look, scale):
    """Writes what he set on a run's properties and leaves the rest as it was."""
    if 'bold' in look:
        rpr.set('b', '1' if look['bold'] else '0')
    if 'italic' in look:
        rpr.set('i', '1' if look['italic'] else '0')
    if 'underline' in look:
        rpr.set('u', 'sng' if look['underline'] else 'none')
    if 'size' in look:
        # A shape that shrinks its text draws it at a share of its size: the size he asks for is the size drawn.
        rpr.set('sz', str(max(100, min(400000, int(round(float(look['size']) * 100 / scale))))))
    if 'font' in look:
        for tag in ('latin', 'cs'):
            f = OxmlElement('a:' + tag)
            f.set('typeface', clean(look['font']))
            put(rpr, f, RPR_ORDER)
    if 'color' in look:
        put(rpr, colour_el(look['color']), RPR_ORDER, [f for f in FILLS if f != 'solidFill'])


def set_para(p, props):
    """Writes a paragraph's level, alignment and list where he set them."""
    if not any(k in props for k in PARA):
        return
    ppr = p.find(qn('a:pPr'))
    if ppr is None:
        ppr = OxmlElement('a:pPr')
        p.insert(0, ppr)
    if 'level' in props:
        ppr.set('lvl', str(max(0, min(8, int(props['level'])))))
    if 'align' in props:
        ppr.set('algn', ALGN[props['align']])
    kind = props.get('list')
    if kind == 'none':
        # as PowerPoint writes a paragraph taken out of a list: no mark, and no hanging indent left behind
        ppr.set('marL', '0')
        ppr.set('indent', '0')
        put(ppr, OxmlElement('a:buNone'), PPR_ORDER, BULLETS)
    elif kind in ('bullet', 'number'):
        if kind == 'bullet':
            mark = OxmlElement('a:buChar')
            mark.set('char', '•')
            font = OxmlElement('a:buFont')
            font.set('typeface', 'Arial')
            put(ppr, font, PPR_ORDER, ('buFontTx',))
        else:
            mark = OxmlElement('a:buAutoNum')
            mark.set('type', 'arabicPeriod')
        put(ppr, mark, PPR_ORDER, BULLETS)
        if ppr.get('marL') in (None, '0'):
            ppr.set('marL', '342900')
            ppr.set('indent', '-342900')


def font_scale(body):
    fit = body.find(qn('a:bodyPr') + '/' + qn('a:normAutofit'))
    try:
        return int(fit.get('fontScale')) / 100000.0 if fit is not None and fit.get('fontScale') else 1.0
    except ValueError:
        return 1.0


def bodies_of(prs, op, whole_table=False):
    """The text bodies an edit names: a shape's own, one cell's, or (for a look on a whole table) every cell's."""
    slide, _ = slide_by_id(prs, op['slide'])
    sh = shape_on(slide, op['slide'], op['shape'])
    if getattr(sh, 'has_table', False):
        t = sh.table
        if 'row' in op and 'col' in op:
            if op['row'] >= len(t.rows) or op['col'] >= len(t.columns):
                raise Fail('the table %s on slide %d has %d rows and %d columns; there is no cell %d, %d' % (sh.name, op['slide'], len(t.rows), len(t.columns), op['row'], op['col']))
            return [t.cell(op['row'], op['col']).text_frame._txBody]
        if whole_table:
            return [c.text_frame._txBody for row in t.rows for c in row.cells]
        raise Fail('name a cell of the table %s on slide %d by its row and column' % (sh.name, op['slide']))
    if not sh.has_text_frame:
        raise Fail('shape %s on slide %d holds no text' % (sh.name, op['slide']))
    return [sh.text_frame._txBody]


def runs_in(p):
    return [c for c in p if c.tag in RUN_TAGS]


def run_text(el):
    return '\n' if el.tag == qn('a:br') else ''.join(t.text or '' for t in el.findall(qn('a:t')))


def with_rpr(el, rpr):
    """el with rpr (a copy) as its run properties, first among its children as the schema wants."""
    old = el.find(qn('a:rPr'))
    if old is not None:
        el.remove(old)
    if rpr is not None:
        el.insert(0, copy.deepcopy(rpr))
    return el


def op_runs(prs, op):
    """A shape's paragraphs as he left them: each run keeps the look of the run it came from, with what he set on top."""
    body = bodies_of(prs, op)[0]
    scale = font_scale(body)
    old = body.findall(qn('a:p'))
    made = []
    for i, para in enumerate(op['paragraphs']):
        src = para.get('from')
        base = old[src] if isinstance(src, int) and 0 <= src < len(old) else (old[min(i, len(old) - 1)] if old else None)
        p = OxmlElement('a:p')
        end = None
        fallback = None
        if base is not None:
            ppr = base.find(qn('a:pPr'))
            if ppr is not None:
                p.append(copy.deepcopy(ppr))
            end = base.find(qn('a:endParaRPr'))
            first = base.find(qn('a:r') + '/' + qn('a:rPr'))
            fallback = first if first is not None else (as_rpr(end) if end is not None else None)
        set_para(p, para)
        last = None
        for run in para['runs']:
            f = run.get('from')
            srcel = None
            if isinstance(f, list) and len(f) == 2 and 0 <= f[0] < len(old):
                kids = runs_in(old[f[0]])
                if 0 <= f[1] < len(kids):
                    srcel = kids[f[1]]
            rpr = copy.deepcopy(srcel.find(qn('a:rPr'))) if srcel is not None and srcel.find(qn('a:rPr')) is not None else (copy.deepcopy(fallback) if srcel is None and fallback is not None else None)
            look = dict((k, run[k]) for k in LOOK if k in run)
            if look:
                if rpr is None:
                    rpr = OxmlElement('a:rPr')
                set_look(rpr, look, scale)
            last = rpr
            text = run.get('text', '')
            # A field (the slide's number, a date) he did not retype stays a field.
            if srcel is not None and srcel.tag == qn('a:fld') and text == run_text(srcel):
                p.append(with_rpr(copy.deepcopy(srcel), rpr))
                continue
            for j, piece in enumerate(re.split('[\n\v]', text)):
                if j:
                    p.append(with_rpr(OxmlElement('a:br'), rpr))
                if piece:
                    r = with_rpr(OxmlElement('a:r'), rpr)
                    t = OxmlElement('a:t')
                    t.text = clean(piece)
                    r.append(t)
                    p.append(r)
        if not runs_in(p) and last is not None:
            # An empty paragraph keeps the look his next words will take.
            end = OxmlElement('a:endParaRPr')
            for k, v in last.attrib.items():
                end.set(k, v)
            for child in last:
                end.append(copy.deepcopy(child))
            p.append(end)
        elif end is not None:
            p.append(copy.deepcopy(end))
        made.append(p)
    if not made:
        raise Fail('a shape keeps at least one paragraph')
    for p in old:
        body.remove(p)
    for p in made:
        body.append(p)


def split_run(r, at):
    """Cuts an a:r in two at a character; answers the second half, placed after the first."""
    t = r.find(qn('a:t'))
    text = t.text or ''
    second = copy.deepcopy(r)
    t.text = text[:at]
    second.find(qn('a:t')).text = text[at:]
    r.addnext(second)
    return second


def op_format(prs, op):
    """A look on a whole shape, on a cell or a whole table, or on a range of a shape's characters."""
    look = dict((k, op['set'][k]) for k in LOOK if k in op['set'])
    para = dict((k, op['set'][k]) for k in PARA if k in op['set'])
    rng = op.get('range')
    for body in bodies_of(prs, op, whole_table=rng is None):
        scale = font_scale(body)
        ps = body.findall(qn('a:p'))
        if rng is not None:
            (p0, c0), (p1, c1) = rng['from'], rng['to']
            if (p1, c1) < (p0, c0):
                (p0, c0), (p1, c1) = (p1, c1), (p0, c0)
            if p0 >= len(ps):
                raise Fail('the shape has %d paragraphs; there is no paragraph %d' % (len(ps), p0 + 1))
        for i, p in enumerate(ps):
            if rng is not None and not (p0 <= i <= p1):
                continue
            set_para(p, para)
            if not look:
                continue
            lo = c0 if rng is not None and i == p0 else 0
            hi = c1 if rng is not None and i == p1 else None
            at = 0
            for el in runs_in(p):
                n = len(run_text(el))
                start, stop = at, at + n
                at = stop
                if stop <= lo or (hi is not None and start >= hi):
                    continue
                if el.tag == qn('a:r'):
                    if start < lo:
                        el = split_run(el, lo - start)
                        start = lo
                    if hi is not None and stop > hi:
                        split_run(el, hi - start)
                rpr = el.find(qn('a:rPr'))
                if rpr is None:
                    rpr = OxmlElement('a:rPr')
                    el.insert(0, rpr)
                set_look(rpr, look, scale)
            # The whole of a paragraph: its end mark takes the look too, so words typed after it match.
            if lo == 0 and hi is None:
                end = p.find(qn('a:endParaRPr'))
                if end is None and not runs_in(p):
                    end = OxmlElement('a:endParaRPr')
                    p.append(end)
                if end is not None:
                    set_look(end, look, scale)


# ── his own edits: shapes ────────────────────────────────────────────

SPPR_ORDER = ['xfrm', 'custGeom', 'prstGeom', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'ln', 'effectLst', 'effectDag', 'scene3d', 'sp3d', 'extLst']
LN_ORDER = ['noFill', 'solidFill', 'gradFill', 'pattFill', 'prstDash', 'custDash', 'round', 'bevel', 'miter', 'headEnd', 'tailEnd', 'extLst']
LN_FILLS = ('noFill', 'solidFill', 'gradFill', 'pattFill')
DASH = {'solid': 'solid', 'dash': 'dash', 'dot': 'sysDot'}
SHAPE_TAGS = (qn('p:sp'), qn('p:pic'), qn('p:grpSp'), qn('p:graphicFrame'), qn('p:cxnSp'))
MC_ALT = '{%s}AlternateContent' % NS_MC
MERGED = ('gridSpan', 'rowSpan', 'hMerge', 'vMerge')
VIDEO_MIME = {'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv', '.avi': 'video/x-msvideo', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg'}
# Where the files an edit brings (a picture, a video) are: beside the edits, named by the host (f0, f1, ...).
FILES_DIR = ['']


def colour_el(spec):
    """A solid fill of a colour: a hex, or one of the theme's by its slot with Office's tint (lighter above 0, darker below)."""
    fill = OxmlElement('a:solidFill')
    if isinstance(spec, str):
        c = OxmlElement('a:srgbClr')
        c.set('val', spec.upper())
    else:
        c = OxmlElement('a:schemeClr')
        c.set('val', spec['slot'])
        tint = float(spec.get('tint') or 0)
        if tint > 0:
            for tag, val in (('a:lumMod', 1 - tint), ('a:lumOff', tint)):
                e = OxmlElement(tag)
                e.set('val', str(int(round(val * 100000))))
                c.append(e)
        elif tint < 0:
            e = OxmlElement('a:lumMod')
            e.set('val', str(int(round((1 + tint) * 100000))))
            c.append(e)
    fill.append(c)
    return fill


def the_shape(prs, op):
    slide, _ = slide_by_id(prs, op['slide'])
    return slide, shape_on(slide, op['slide'], op['shape'])


def unit_of(el):
    """What moves or goes as one in its parent's list: the shape, or the compatibility wrapper PowerPoint put it in."""
    while el.getparent() is not None and el.getparent().tag not in (qn('p:spTree'), qn('p:grpSp')):
        el = el.getparent()
    return el


def to_group_space(el, x, y, w, h):
    """A box on the slide as the numbers the shape's own xfrm holds, through every group above it. A group that is
    turned or flipped is PowerPoint's to edit in."""
    chain = []
    p = el.getparent()
    while p is not None:
        if p.tag == qn('p:grpSp'):
            chain.insert(0, p)
        p = p.getparent()
    for g in chain:
        xf = xfrm_of(g)
        if xf is None:
            continue
        rot, fh, fv = turn_of(xf)
        if rot or fh or fv:
            raise Fail('the shape is in a group that is turned or flipped; move it in PowerPoint')
        off, ext, choff, chext = (xf.find(qn('a:' + n)) for n in ('off', 'ext', 'chOff', 'chExt'))
        if off is None or ext is None or choff is None or chext is None:
            continue
        ex, ey = int(ext.get('cx', 0)), int(ext.get('cy', 0))
        if not ex or not ey:
            raise Fail('the shape is in a group with no size; move it in PowerPoint')
        sx, sy = int(chext.get('cx', 0)) / ex, int(chext.get('cy', 0)) / ey
        x = int(choff.get('x', 0)) + (x - int(off.get('x', 0))) * sx
        y = int(choff.get('y', 0)) + (y - int(off.get('y', 0))) * sy
        w, h = w * sx, h * sy
    return int(round(x)), int(round(y)), int(round(w)), int(round(h))


def op_geometry(prs, op):
    """Where a shape is, how big, how far turned and whether mirrored: its box as it lies on the slide before any turn."""
    _, sh = the_shape(prs, op)
    el = sh._element
    if 'box' in op:
        x, y, w, h = to_group_space(el, *op['box'])
        if w < 1 or h < 1:
            raise Fail('a shape keeps some width and height')
        sh.left, sh.top, sh.width, sh.height = Emu(x), Emu(y), Emu(w), Emu(h)
    if any(k in op for k in ('rot', 'flipH', 'flipV')):
        if el.tag == qn('p:graphicFrame'):
            raise Fail('a table, a chart or a diagram cannot be turned or mirrored')
        xf = xfrm_of(el)
        if xf is None:
            # a placeholder that takes its place from its layout: given its own box first
            sh.left, sh.top, sh.width, sh.height = sh.left, sh.top, sh.width, sh.height
            xf = xfrm_of(el)
        if xf is None:
            raise Fail('this shape has no place of its own to turn')
        if 'rot' in op:
            deg = float(op['rot']) % 360
            if deg:
                xf.set('rot', str(int(round(deg * 60000))))
            elif 'rot' in xf.attrib:
                del xf.attrib['rot']
        for key in ('flipH', 'flipV'):
            if key in op:
                if op[key]:
                    xf.set(key, '1')
                elif key in xf.attrib:
                    del xf.attrib[key]


def op_order(prs, op):
    """A shape's place among those it lies over and under, within its own group."""
    _, sh = the_shape(prs, op)
    el = unit_of(sh._element)
    parent = el.getparent()
    sibs = [c for c in parent if c.tag in SHAPE_TAGS or c.tag == MC_ALT]
    i = sibs.index(el)
    to = op['to']
    if to == 'front' and i < len(sibs) - 1:
        sibs[-1].addnext(el)
    elif to == 'back' and i > 0:
        sibs[0].addprevious(el)
    elif to == 'forward' and i < len(sibs) - 1:
        sibs[i + 1].addnext(el)
    elif to == 'backward' and i > 0:
        sibs[i - 1].addprevious(el)


def drop_timing(slide, ids):
    """The effects that played on shapes that are going leave with them: PowerPoint repairs a slide whose timing
    names a shape it no longer has."""
    timing = slide._element.find(qn('p:timing'))
    if timing is None:
        return
    lst_tag = qn('p:childTnLst')
    for tgt in list(timing.iter(qn('p:spTgt'))):
        try:
            if int(tgt.get('spid', '')) not in ids:
                continue
        except ValueError:
            continue
        # the effect: the nearest node above that is one of a list of time nodes
        node = tgt
        while node is not None and not (node.getparent() is not None and node.getparent().tag == lst_tag and node.tag in (qn('p:par'), qn('p:seq'), qn('p:excl'), qn('p:video'), qn('p:audio'), qn('p:cmd'))):
            node = node.getparent()
        if node is None:
            continue
        # for a build, the whole effect (the node that carries its preset), not one behaviour of it
        effect = node
        up = node
        while up is not None and up is not timing:
            ctn = up.find(qn('p:cTn'))
            if up.tag == qn('p:par') and ctn is not None and ctn.get('presetID') is not None and up.getparent() is not None and up.getparent().tag == lst_tag:
                effect = up
                break
            up = up.getparent()
        if effect.getparent() is None:
            continue
        lst = effect.getparent()
        lst.remove(effect)
        # a list left empty takes its node with it, up to the main sequence; an empty main sequence takes the timing
        while len(lst) == 0:
            ctn = lst.getparent()
            holder = ctn.getparent() if ctn is not None else None
            above = holder.getparent() if holder is not None else None
            if holder is None or holder.tag != qn('p:par') or above is None or above.tag != lst_tag:
                if timing.getparent() is not None:
                    timing.getparent().remove(timing)
                return
            above.remove(holder)
            lst = above
    for b in list(timing.iter(qn('p:bldP'))) + list(timing.iter(qn('p:bldDgm'))) + list(timing.iter(qn('p:bldOleChart'))) + list(timing.iter(qn('p:bldGraphic'))):
        try:
            if int(b.get('spid', '')) in ids and b.getparent() is not None:
                b.getparent().remove(b)
        except ValueError:
            pass
    bld = timing.find(qn('p:bldLst'))
    if bld is not None and len(bld) == 0:
        timing.remove(bld)
    if not list(timing.iter(qn('p:spTgt'))) and timing.getparent() is not None:
        timing.getparent().remove(timing)


def op_delete(prs, op):
    """A shape leaves its slide, with what only it used: its picture, chart or media, and its effects."""
    slide, sh = the_shape(prs, op)
    el = unit_of(sh._element)
    rids = set(v for e in el.iter('*') for k, v in e.attrib.items() if k.startswith('{%s}' % NS_R))
    ids = set()
    for e in el.iter(qn('p:cNvPr')):
        try:
            ids.add(int(e.get('id')))
        except (TypeError, ValueError):
            pass
    el.getparent().remove(el)
    drop_timing(slide, ids)
    for rid in rids:
        if rid in slide.part.rels and not refs_to(slide.part, rid):
            slide.part.drop_rel(rid)


def attached(op, what):
    name = op.get('file') or ''
    path = os.path.join(FILES_DIR[0], name)
    if not re.match(r'^f\d+(\.[A-Za-z0-9]{1,8})?$', name) or not FILES_DIR[0] or not os.path.isfile(path):
        raise Fail('the %s to add did not come with the edit' % what)
    return path


def op_insert(prs, op):
    """A new shape on a slide: a text box, a drawn shape, a picture, a table, a chart or a video, in its box."""
    slide, _ = slide_by_id(prs, op['slide'])
    x, y, w, h = (Emu(int(v)) for v in op['box'])
    if w < 1 or h < 1:
        raise Fail('a shape keeps some width and height')
    new_id = op.get('id')
    if new_id is not None and any(int(e.get('id', -1)) == new_id for e in slide._element.iter(qn('p:cNvPr'))):
        raise Fail('slide %d already has a shape %d' % (op['slide'], new_id))
    what = op['what']
    shapes = slide.shapes
    if what == 'text':
        sh = shapes.add_textbox(x, y, w, h)
        sh.text_frame.word_wrap = True
    elif what == 'shape':
        preset = next((m for m in MSO_SHAPE if m.xml_value == op.get('preset', 'rect')), None)
        if preset is None:
            raise Fail('%s is not a shape PowerPoint has' % op.get('preset'))
        sh = shapes.add_shape(preset, x, y, w, h)
    elif what == 'picture':
        try:
            sh = shapes.add_picture(attached(op, 'picture'), x, y, w, h)
        except Fail:
            raise
        except Exception:
            raise Fail('that file is not a picture a deck can hold (PNG, JPEG, GIF, BMP or TIFF)')
    elif what == 'table':
        rows, cols = int(op.get('rows', 2)), int(op.get('cols', 2))
        sh = shapes.add_table(rows, cols, x, y, w, h)
    elif what == 'chart':
        c = op.get('chart') or {}
        n = len(c.get('categories') or [])
        if not n or not c.get('series'):
            raise Fail('a chart needs its categories and at least one series')
        data = CategoryChartData()
        data.categories = c['categories']
        for s in c['series']:
            if len(s['values']) != n:
                raise Fail('series %s has %d values for %d categories' % (s['name'], len(s['values']), n))
            data.add_series(s['name'], s['values'])
        kind = {'bar': XL_CHART_TYPE.COLUMN_CLUSTERED, 'line': XL_CHART_TYPE.LINE, 'pie': XL_CHART_TYPE.PIE}[c.get('type', 'bar')]
        sh = shapes.add_chart(kind, x, y, w, h, data)
    elif what == 'video':
        path = attached(op, 'video')
        mime = VIDEO_MIME.get(os.path.splitext(path)[1].lower())
        if mime is None:
            raise Fail('that file is not a video a deck can hold (MP4, MOV, WMV, AVI or MPEG)')
        sh = shapes.add_movie(path, x, y, w, h, poster_frame_image=None, mime_type=mime)
    else:
        raise Fail('%s is not a thing to add to a slide' % what)
    if op.get('text') and getattr(sh, 'has_text_frame', False):
        set_paragraphs(sh.text_frame._txBody, re.split('\n', op['text']))
    if new_id is not None:
        nv = next(sh._element.iter(qn('p:cNvPr')), None)
        if nv is not None:
            old = nv.get('id')
            nv.set('id', str(new_id))
            # a video's timing names its shape by the id python-pptx gave it
            for tgt in slide._element.iter(qn('p:spTgt')):
                if tgt.get('spid') == old:
                    tgt.set('spid', str(new_id))


def sppr_of(sh, what):
    sppr = sh._element.find(qn('p:spPr'))
    if sppr is None:
        raise Fail('this shape takes no %s; a table\'s and a chart\'s are set in PowerPoint' % what)
    return sppr


def op_fill(prs, op):
    """A shape's fill: a colour, or none."""
    _, sh = the_shape(prs, op)
    sppr = sppr_of(sh, 'fill')
    new = OxmlElement('a:noFill') if op.get('color') is None else colour_el(op['color'])
    put(sppr, new, SPPR_ORDER, [f for f in FILLS if f != etree.QName(new).localname])


def op_line(prs, op):
    """A shape's outline: its colour (or none), its weight in points, its dash."""
    _, sh = the_shape(prs, op)
    sppr = sppr_of(sh, 'outline')
    ln = sppr.find(qn('a:ln'))
    if ln is None:
        ln = OxmlElement('a:ln')
        put(sppr, ln, SPPR_ORDER)
    if 'width' in op:
        ln.set('w', str(max(0, min(20116800, int(round(float(op['width']) * 12700))))))
    if 'color' in op:
        new = OxmlElement('a:noFill') if op['color'] is None else colour_el(op['color'])
        put(ln, new, LN_ORDER, [f for f in LN_FILLS if f != etree.QName(new).localname])
    if 'dash' in op:
        d = OxmlElement('a:prstDash')
        d.set('val', DASH[op['dash']])
        put(ln, d, LN_ORDER, ('custDash',))


def blank_cell(tc):
    """A copied cell with no words: its look kept."""
    body = tc.find(qn('a:txBody'))
    if body is None:
        return
    ps = body.findall(qn('a:p'))
    for p in ps[1:]:
        body.remove(p)
    for child in list(ps[0]) if ps else []:
        if child.tag in RUN_TAGS:
            ps[0].remove(child)


def no_ids(el):
    """Without the ids PowerPoint gives a row and a column for itself: a copy must not carry another's."""
    for ext in list(el.findall(qn('a:extLst'))):
        el.remove(ext)
    return el


def op_grid(prs, op):
    """A table's rows and columns: one put in before a place, or one taken out; the table grows and shrinks by it."""
    _, sh = the_shape(prs, op)
    if not getattr(sh, 'has_table', False):
        raise Fail('shape %s on slide %d is not a table' % (sh.name, op['slide']))
    tbl = next(sh._element.iter(qn('a:tbl')))
    if any(tc.get(k) is not None for tc in tbl.iter(qn('a:tc')) for k in MERGED):
        raise Fail('the table %s has merged cells; change its rows and columns in PowerPoint' % sh.name)
    rows = tbl.findall(qn('a:tr'))
    grid = tbl.find(qn('a:tblGrid'))
    cols = grid.findall(qn('a:gridCol')) if grid is not None else []
    at, act = int(op['at']), op['act']
    if op['what'] == 'row':
        if act == 'insert':
            if at > len(rows):
                raise Fail('the table has %d rows; a row cannot go before row %d' % (len(rows), at + 1))
            new = no_ids(copy.deepcopy(rows[max(0, at - 1)]))
            for tc in new.findall(qn('a:tc')):
                blank_cell(tc)
            if at < len(rows):
                rows[at].addprevious(new)
            else:
                rows[-1].addnext(new)
            sh.height = Emu(int(sh.height) + int(new.get('h', 0)))
        else:
            if len(rows) < 2:
                raise Fail('a table keeps at least one row')
            if at >= len(rows):
                raise Fail('the table has %d rows; there is no row %d' % (len(rows), at + 1))
            tall = int(rows[at].get('h', 0))
            tbl.remove(rows[at])
            sh.height = Emu(max(1, int(sh.height) - tall))
    else:
        if act == 'insert':
            if at > len(cols):
                raise Fail('the table has %d columns; a column cannot go before column %d' % (len(cols), at + 1))
            model = max(0, at - 1)
            col = no_ids(copy.deepcopy(cols[model]))
            if at < len(cols):
                cols[at].addprevious(col)
            else:
                cols[-1].addnext(col)
            for tr in rows:
                tcs = tr.findall(qn('a:tc'))
                tc = copy.deepcopy(tcs[model])
                blank_cell(tc)
                if at < len(tcs):
                    tcs[at].addprevious(tc)
                else:
                    tcs[-1].addnext(tc)
            sh.width = Emu(int(sh.width) + int(col.get('w', 0)))
        else:
            if len(cols) < 2:
                raise Fail('a table keeps at least one column')
            if at >= len(cols):
                raise Fail('the table has %d columns; there is no column %d' % (len(cols), at + 1))
            wide = int(cols[at].get('w', 0))
            grid.remove(cols[at])
            for tr in rows:
                tcs = tr.findall(qn('a:tc'))
                if at < len(tcs):
                    tr.remove(tcs[at])
            sh.width = Emu(max(1, int(sh.width) - wide))


def op_hide(prs, op):
    """A slide left out of the show, or put back in."""
    slide, _ = slide_by_id(prs, op['slide'])
    if op['hidden']:
        slide._element.set('show', '0')
    elif 'show' in slide._element.attrib:
        del slide._element.attrib['show']


# Parts a slide holds for itself alone: a copy of the slide takes a copy of each (and of what that holds).
OWN_PARTS = ('/chart', '/chartStyle', '/chartColorStyle', '/chartUserShapes', '/package', '/oleObject', '/diagramData', '/diagramLayout', '/diagramQuickStyle', '/diagramColors', '/diagramDrawing')


def clone_part(part):
    """A copy of a part under a free name of its own kind, with a copy of every part it holds for itself."""
    pkg = part.package
    m = re.match(r'^(.*?)(\d+)(\.[^./]+)$', str(part.partname))
    name = pkg.next_partname(m.group(1) + '%d' + m.group(3)) if m else PackURI(re.sub(r'(\.[^./]+)$', r'-copy\1', str(part.partname)))
    new = part.__class__.load(name, part.content_type, pkg, part.blob)
    ids = {}
    for rid, rel in part.rels.items():
        if rel.is_external:
            ids[rid] = new.relate_to(rel.target_ref, rel.reltype, is_external=True)
        elif rel.reltype.endswith(OWN_PARTS):
            ids[rid] = new.relate_to(clone_part(rel.target_part), rel.reltype)
        else:
            ids[rid] = new.relate_to(rel.target_part, rel.reltype)
    if hasattr(new, '_element'):
        rename_rids(new._element, ids)
    return new


def rename_rids(root, ids):
    for e in root.iter('*'):
        for k, v in list(e.attrib.items()):
            if k.startswith('{%s}' % NS_R) and v in ids:
                e.set(k, ids[v])


def op_duplicate(prs, op):
    """A copy of a slide, right after it: its shapes, pictures, charts, effects and notes."""
    slide, _ = slide_by_id(prs, op['slide'])
    sid = op.get('id')
    if sid is not None:
        if sid < 256 or sid > 2147483647:
            raise Fail('a slide id is from 256 to 2147483647, not %d' % sid)
        if any(e.id == sid for e in prs.slides._sldIdLst):
            raise Fail('the deck already has a slide %d' % sid)
    prs.part.rename_slide_parts([e.rId for e in prs.slides._sldIdLst])
    new = prs.slides.add_slide(slide.slide_layout)
    nel = prs.slides._sldIdLst[-1]
    if sid is not None:
        nel.set('id', str(sid))
    src, dst = slide.part, new.part
    layout_rid = next(rid for rid, rel in dst.rels.items() if rel.reltype.endswith('/slideLayout'))
    ids = {}
    for rid, rel in src.rels.items():
        if rel.reltype.endswith('/slideLayout'):
            ids[rid] = layout_rid
        elif rel.reltype.endswith('/notesSlide'):
            continue
        elif rel.is_external:
            ids[rid] = dst.relate_to(rel.target_ref, rel.reltype, is_external=True)
        elif rel.reltype.endswith(OWN_PARTS):
            ids[rid] = dst.relate_to(clone_part(rel.target_part), rel.reltype)
        elif rel.target_part is src:
            ids[rid] = dst.relate_to(dst, rel.reltype)
        else:
            ids[rid] = dst.relate_to(rel.target_part, rel.reltype)
    # The copy's XML is the slide's own, put into the new part's element in place: python-pptx keeps that element.
    body = copy.deepcopy(src._element)
    rename_rids(body, ids)
    el = dst._element
    for child in list(el):
        el.remove(child)
    for k in list(el.attrib):
        del el.attrib[k]
    for k, v in body.attrib.items():
        el.set(k, v)
    for child in list(body):
        el.append(child)
    if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
        said = text_of(slide.notes_slide.notes_text_frame)
        if said and new.notes_slide.notes_text_frame is not None:
            set_paragraphs(new.notes_slide.notes_text_frame._txBody, said.split('\n'))
    place_after(prs, nel, op['slide'])
    section_place(prs, nel.id, op['slide'])


SECTION_URI = '{521415D9-36F7-43E2-AB2F-B90AF26B5E84}'


def section_el(name, ids):
    s = etree.Element('{%s}section' % NS_P14)
    s.set('name', clean(name))
    s.set('id', '{%s}' % str(uuid.uuid4()).upper())
    lst = etree.SubElement(s, '{%s}sldIdLst' % NS_P14)
    for sid in ids:
        etree.SubElement(lst, '{%s}sldId' % NS_P14).set('id', str(sid))
    return s


def op_section(prs, op):
    """The deck's sections: one started at a slide, one renamed, one taken away (its slides stay, in the one before)."""
    lst = section_list(prs)
    act = op['act']
    if act == 'add':
        sid = op['at']
        order = [e.id for e in prs.slides._sldIdLst]
        if sid not in order:
            raise Fail('there is no slide %d to start a section at' % sid)
        if lst is None:
            # as PowerPoint does it: the slides before the new section become the default one
            pres = prs.part._element
            ext_lst = pres.find(qn('p:extLst'))
            if ext_lst is None:
                ext_lst = etree.SubElement(pres, qn('p:extLst'))
            ext = etree.SubElement(ext_lst, qn('p:ext'))
            ext.set('uri', SECTION_URI)
            lst = etree.SubElement(ext, '{%s}sectionLst' % NS_P14, nsmap={'p14': NS_P14})
            before = order[:order.index(sid)]
            if before:
                lst.append(section_el('Default Section', before))
            lst.append(section_el(op['name'], order[order.index(sid):]))
            return
        for s in lst.findall('{%s}section' % NS_P14):
            ids = s.find('{%s}sldIdLst' % NS_P14)
            mine = [e for e in (ids if ids is not None else [])]
            at = next((i for i, e in enumerate(mine) if e.get('id') == str(sid)), None)
            if at is None:
                continue
            if at == 0:
                raise Fail('a section already starts at slide %d; rename it' % sid)
            new = section_el(op['name'], [])
            moved = new.find('{%s}sldIdLst' % NS_P14)
            for e in mine[at:]:
                moved.append(e)
            s.addnext(new)
            return
        raise Fail('slide %d is in no section' % sid)
    sections = lst.findall('{%s}section' % NS_P14) if lst is not None else []
    i = op['section']
    if i >= len(sections):
        raise Fail('the deck has %d sections; there is no section %d' % (len(sections), i + 1))
    if act == 'rename':
        sections[i].set('name', clean(op['name']))
        return
    # remove: its slides join the section before it (the one after, for the first)
    gone = sections[i]
    ids = gone.find('{%s}sldIdLst' % NS_P14)
    mine = list(ids) if ids is not None else []
    if len(sections) == 1:
        ext = lst.getparent()
        holder = ext.getparent()
        holder.remove(ext)
        if len(holder) == 0:
            holder.getparent().remove(holder)
        return
    into = sections[i - 1] if i > 0 else sections[1]
    target = into.find('{%s}sldIdLst' % NS_P14)
    if target is None:
        target = etree.SubElement(into, '{%s}sldIdLst' % NS_P14)
    if i > 0:
        for e in mine:
            target.append(e)
    else:
        for e in reversed(mine):
            target.insert(0, e)
    lst.remove(gone)


def holds_of(shape_or_layout):
    """The placeholders of a slide or a layout by index: each one's kind as a slide's layout must match it."""
    out = {}
    for ph in shape_or_layout.placeholders:
        el = ph._element.find('.//' + qn('p:nvPr') + '/' + qn('p:ph'))
        if el is None:
            continue
        t = el.get('type', 'obj')
        out[int(el.get('idx', 0))] = 'title' if t in ('title', 'ctrTitle') else 'body' if t in ('body', 'obj', 'subTitle') else t
    return out


def op_layout(prs, op):
    """Another of the deck's layouts for a slide: only where each of the slide's placeholders has its match there."""
    slide, _ = slide_by_id(prs, op['slide'])
    target = next((l for m in prs.slide_masters for l in m.slide_layouts if l.name == op['layout']), None)
    if target is None:
        raise Fail('the deck has no layout named %s; its layouts are %s' % (op['layout'], ', '.join(layout_names(prs))))
    if target.part is slide.slide_layout.part:
        return
    want = holds_of(target)
    for idx, kind in holds_of(slide).items():
        if want.get(idx) != kind:
            raise Fail('the layout %s has no place for what this slide holds; change this layout in PowerPoint' % op['layout'])
    rel = next(r for r in slide.part.rels.values() if r.reltype.endswith('/slideLayout'))
    rel._target = target.part


THEME_SLOTS = ('dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink')


def op_theme(prs, op):
    """The deck's colours and fonts: written into the theme of every slide master, and nothing else."""
    done = set()
    for master in prs.slide_masters:
        rel = next((r for r in master.part.rels.values() if r.reltype.endswith('/theme')), None)
        if rel is None or id(rel.target_part) in done:
            continue
        part = rel.target_part
        done.add(id(part))
        root = etree.fromstring(part.blob, PARSER)
        scheme = xp(root, './a:themeElements/a:clrScheme')
        for slot, value in (op.get('colors') or {}).items():
            if slot not in THEME_SLOTS or not scheme:
                continue
            el = scheme[0].find('{%s}%s' % (NS_A, slot))
            if el is None:
                continue
            for child in list(el):
                el.remove(child)
            etree.SubElement(el, '{%s}srgbClr' % NS_A).set('val', value.upper())
        for key, path in (('major', './a:themeElements/a:fontScheme/a:majorFont/a:latin'), ('minor', './a:themeElements/a:fontScheme/a:minorFont/a:latin')):
            if op.get(key):
                for el in xp(root, path):
                    el.set('typeface', clean(op[key]))
        part._blob = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)


# ── his own edits: how a slide comes and builds ──────────────────────

# What an appear-on-a-press build may stand beside in a slide's timing: Appear and Fade entrances of whole shapes.
SIMPLE_PRESETS = ('1', '10')
NOT_SIMPLE = ('audio', 'video', 'cmd', 'animMotion', 'animScale', 'animRot', 'animClr', 'txEl', 'graphicEl', 'oleChartEl', 'subSp', 'sndTgt', 'inkTgt')
# One press that brings a whole shape in, as PowerPoint writes it: the effect's number (1 Appear, 10 Fade), its group,
# the shape, and what follows the switch to visible. Every id is 0 here: op_builds numbers the whole timing at its end.
PRESS = ('<p:par xmlns:p="' + NS_P + '"><p:cTn id="0" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>'
         '<p:par><p:cTn id="0" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
         '<p:par><p:cTn id="0" presetID="%d" presetClass="entr" presetSubtype="0" fill="hold"%s nodeType="clickEffect">'
         '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
         '<p:set><p:cBhvr><p:cTn id="0" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>'
         '<p:tgtEl><p:spTgt spid="%d"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>'
         '<p:to><p:strVal val="visible"/></p:to></p:set>%s'
         '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>')
# PowerPoint's Fade as it first sets it: half a second.
FADE = '<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="0" dur="500"/><p:tgtEl><p:spTgt spid="%d"/></p:tgtEl></p:cBhvr></p:animEffect>'


def before_tail(root, el, tails):
    """Puts el among a slide's children before the first of 'tails' that is there, else last."""
    for name in tails:
        at = root.find(qn(name))
        if at is not None:
            at.addprevious(el)
            return
    root.append(el)


def op_transition(prs, op):
    """How a slide comes in a show: a cut, a fade or a push; whether a press moves on; the seconds after which it
    moves on by itself. Whatever the slide had, PowerPoint's wrapped newer kinds too, is replaced."""
    slide, _ = slide_by_id(prs, op['slide'])
    root = slide._element
    for c in list(root):
        if c.tag == qn('p:transition') or (c.tag == MC_ALT and next(c.iter(qn('p:transition')), None) is not None):
            root.remove(c)
    kind, after, click = op['kind'], op.get('after'), op.get('click', True)
    if kind == 'none' and after is None and click:
        return
    tr = OxmlElement('p:transition')
    if kind != 'none':
        tr.set('spd', 'med')
    if not click:
        tr.set('advClick', '0')
    if after is not None:
        tr.set('advTm', str(int(round(float(after) * 1000))))
    if kind == 'fade':
        tr.append(OxmlElement('p:fade'))
    elif kind == 'push':
        push = OxmlElement('p:push')
        push.set('dir', op.get('dir', 'l'))
        tr.append(push)
    before_tail(root, tr, ('p:timing', 'p:extLst'))


def simple_timing(timing):
    """Whether a slide's timing is no more than Appear and Fade entrances of whole shapes on presses."""
    for el in timing.iter('*'):
        if not isinstance(el.tag, str):
            continue
        name = etree.QName(el).localname
        if name in NOT_SIMPLE:
            return False
        if name == 'cTn':
            if el.get('nodeType') == 'interactiveSeq':
                return False
            if el.get('presetClass') is not None and (el.get('presetClass') != 'entr' or el.get('presetID') not in SIMPLE_PRESETS):
                return False
    return True


def own_presses(timing):
    """{shape id: (its press, 10 for Fade or 1 for Appear)} for each press of the main sequence whose one effect
    brings one shape in, and no other press does: what a builds edit keeps as the file has it."""
    main = next((c for c in timing.iter(qn('p:cTn')) if c.get('nodeType') == 'mainSeq'), None)
    out, twice = {}, set()
    for press in ([] if main is None else main.findall('%s/%s' % (qn('p:childTnLst'), qn('p:par')))):
        fx = [c for c in press.iter(qn('p:cTn')) if c.get('presetClass') is not None]
        ids = {t.get('spid') for t in press.iter(qn('p:spTgt'))}
        if len(fx) != 1 or len(ids) != 1 or fx[0].get('nodeType') != 'clickEffect':
            continue
        sid = ids.pop()
        if sid in out:
            twice.add(sid)
        out[sid] = (press, 10 if fx[0].get('presetID') == '10' else 1)
    return {k: v for k, v in out.items() if k not in twice}


def op_builds(prs, op):
    """The shapes that come in on a press, one a press, in order: those of 'fade' by Fade, the rest by Appear; none
    takes the builds away. A shape that came in that way on a press of its own keeps its effect as it was (how long a
    fade takes, its delay). A slide whose animations are more than that keeps them for PowerPoint, unless 'replace'
    (his confirmed press) takes them all out."""
    slide, _ = slide_by_id(prs, op['slide'])
    root = slide._element
    timing = root.find(qn('p:timing'))
    if timing is not None and not op.get('replace') and not simple_timing(timing):
        raise Fail('slide %d has animations beyond shapes that appear on a press; edit them in PowerPoint' % op['slide'])
    shapes = [shape_on(slide, op['slide'], ref) for ref in op['order']]
    ids = [sh.shape_id for sh in shapes]
    if len(set(ids)) != len(ids):
        raise Fail('a shape comes in once')
    fades = {shape_on(slide, op['slide'], ref).shape_id for ref in op.get('fade') or []}
    if not fades <= set(ids):
        raise Fail('a shape that fades in is one of the order')
    keep = timing is not None and not op.get('replace')
    was = own_presses(timing) if keep else {}
    was_built = {b.get('spid'): b for b in timing.iter(qn('p:bldP'))} if keep else {}
    if timing is not None:
        root.remove(timing)
    if not ids:
        return
    xml = ('<p:timing xmlns:p="%s"><p:tnLst><p:par><p:cTn id="0" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
           '<p:seq concurrent="1" nextAc="seek"><p:cTn id="0" dur="indefinite" nodeType="mainSeq"><p:childTnLst/></p:cTn>'
           '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
           '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>'
           '</p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst/></p:timing>') % NS_P
    made = etree.fromstring(xml, PARSER)
    presses, built = made.find('.//%s/%s' % (qn('p:seq'), qn('p:cTn')))[0], made[1]
    for sh in shapes:
        sid, preset = str(sh.shape_id), 10 if sh.shape_id in fades else 1
        if sid in was and was[sid][1] == preset:
            presses.append(was[sid][0])
            if sid in was_built:
                built.append(was_built[sid])
            continue
        # as PowerPoint writes it: a shape that can hold words builds as one, background and all
        wordy = sh._element.tag == qn('p:sp')
        presses.append(etree.fromstring(PRESS % (preset, ' grpId="0"' if wordy else '', sh.shape_id, FADE % sh.shape_id if preset == 10 else ''), PARSER))
        if wordy:
            built.append(etree.fromstring('<p:bldP xmlns:p="%s" spid="%d" grpId="0" animBg="1"/>' % (NS_P, sh.shape_id), PARSER))
    if not len(built):
        made.remove(built)
    for n, ctn in enumerate(made.iter(qn('p:cTn')), 1):
        ctn.set('id', str(n))
    before_tail(root, made, ('p:extLst',))


OPS = {'text': op_text, 'cell': op_cell, 'notes': op_notes, 'chart': op_chart, 'add': op_add, 'remove': op_remove, 'move': op_move,
       'runs': op_runs, 'format': op_format, 'geometry': op_geometry, 'order': op_order, 'insert': op_insert, 'delete': op_delete,
       'fill': op_fill, 'line': op_line, 'grid': op_grid, 'hide': op_hide, 'duplicate': op_duplicate, 'section': op_section,
       'layout': op_layout, 'theme': op_theme, 'transition': op_transition, 'builds': op_builds}


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
    FILES_DIR[0] = os.path.join(os.path.dirname(os.path.abspath(ops_path)), 'files')
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


# ── undo packs ───────────────────────────────────────────────────────

def zip_parts(path):
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        return [i.filename for i in infos], dict((i.filename, i) for i in infos), dict((i.filename, z.read(i.filename)) for i in infos)


def write_zip(dst, entries):
    """entries: (name, bytes, ZipInfo or (date_time, external_attr) or None), in order."""
    seen = set()
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data, info in entries:
            if name in seen:
                raise Fail('the deck would be written with two parts named %s, so nothing was written' % name)
            seen.add(name)
            when, attr = (info.date_time, info.external_attr) if isinstance(info, zipfile.ZipInfo) else (info or ((1980, 1, 1, 0, 0, 0), 0))
            zi = zipfile.ZipInfo(name, tuple(when))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = attr
            z.writestr(zi, data)


def pack(frm, to, out):
    """What turns the deck 'to' back into the deck 'frm', part for part: frm's order, the parts 'to' changed or lost, and no more."""
    old_order, old_info, old_raw = zip_parts(frm)
    _, _, new_raw = zip_parts(to)
    kept = [n for n in old_order if new_raw.get(n) != old_raw[n]]
    manifest = {'v': 1, 'order': old_order, 'kept': kept, 'meta': dict((n, [list(old_info[n].date_time), old_info[n].external_attr]) for n in kept)}
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(manifest))
        for i, n in enumerate(kept):
            z.writestr('p/%d' % i, old_raw[n])


def unpack(now, packed, out):
    """Applies a pack to the deck it was made against: every part comes back byte for byte."""
    _, info, raw = zip_parts(now)
    with zipfile.ZipFile(packed) as z:
        manifest = json.loads(z.read('manifest.json'))
        kept = dict((n, z.read('p/%d' % i)) for i, n in enumerate(manifest['kept']))
    entries = []
    for n in manifest['order']:
        if n in kept:
            entries.append((n, kept[n], manifest['meta'][n]))
        elif n in raw:
            entries.append((n, raw[n], info[n]))
        else:
            raise Fail('the deck has changed since that edit, so it cannot be taken back')
    write_zip(out, entries)


def step(src, ops_path, dst, warnings_path, pack_path, info_path):
    """One of his own edits: applied, and when every edit went in, the pack that takes it back and the new deck's outline."""
    apply(src, ops_path, dst, warnings_path)
    with open(warnings_path, encoding='utf-8') as f:
        if any(not w.startswith('note: ') for w in json.load(f)):
            return
    pack(src, dst, pack_path)
    inspect(dst, info_path)


def unstep(now, packed, dst, pack_path, info_path):
    """An edit taken back or put back: the deck after, the pack that reverses that, and its outline."""
    unpack(now, packed, dst)
    pack(now, dst, pack_path)
    inspect(dst, info_path)


def main(argv):
    if len(argv) == 3 and argv[0] == 'inspect':
        inspect(argv[1], argv[2])
    elif len(argv) == 5 and argv[0] == 'apply':
        apply(*argv[1:])
    elif len(argv) == 4 and argv[0] == 'pack':
        pack(*argv[1:])
    elif len(argv) == 4 and argv[0] == 'unpack':
        unpack(*argv[1:])
    elif len(argv) == 3 and argv[0] == 'layouts':
        layouts_deck(argv[1], argv[2])
    elif len(argv) == 7 and argv[0] == 'step':
        step(*argv[1:])
    elif len(argv) == 6 and argv[0] == 'unstep':
        unstep(*argv[1:])
    else:
        raise Fail('usage: deck.py inspect <in> <out.json> | apply <in> <ops.json> <out.pptx> <warnings.json> | pack <from> <to> <out> | unpack <now> <pack> <out>')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as e:
        msg = str(e) if isinstance(e, Fail) else 'the deck could not be read or written: %s' % (str(e) or type(e).__name__)
        sys.stderr.write(msg.replace('\n', ' ') + '\n')
        sys.exit(1)
`
