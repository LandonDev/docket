import type { DocFormat, FormatChange, FormatTarget, ParagraphChange, RunChange } from 'work-kit/collab-server'
import { cleanBand, cleanSetup, cleanStyle, cleanTheme, PAPERS, styleName } from 'work-kit/editor/page'
import { fontText } from 'work-kit/editor/run'
import { colourText, parseColour, THEME_SLOTS } from 'work-kit/format/theme'
import { RouteError } from '../service/routes/route'

export const ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const
export const BAND_FIELDS = ['page', 'pages', 'title', 'date'] as const
export const PAPER_NAMES = Object.keys(PAPERS) as [keyof typeof PAPERS, ...(keyof typeof PAPERS)[]]
const PARA_NUMBERS = { lineSpacing: [0.5, 10], spaceBefore: [0, 1584], spaceAfter: [0, 1584], indent: [0, 1584], firstLine: [-1584, 1584] } as const
const SIDES = ['top', 'right', 'bottom', 'left'] as const
const BANDS = ['start', 'center', 'end'] as const

const invalid = (field: string): never => { throw new RouteError(400, `Invalid document formatting in ${field}`) }
type Fields = Record<string, unknown>

function fields(value: unknown, allowed: readonly string[], name: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) return invalid(name)
  return value as Fields
}

function nonempty(value: Fields, name: string): Fields {
  return Object.keys(value).length ? value : invalid(name)
}

function words(value: unknown, max: number, name: string): string {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : invalid(name)
}

function number(value: unknown, min: number, max: number, name: string): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : invalid(name)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : invalid(name)
}

function boolean(value: unknown, name: string) {
  return typeof value === 'boolean' ? value : invalid(name)
}

function nameOf(value: unknown, field: string) {
  const input = words(value, 120, field)
  return styleName(input) ?? invalid(field)
}

function font(value: unknown, field: string) {
  const input = words(value, 80, field)
  return fontText(input) ?? invalid(field)
}

function colour(value: unknown, field: string) {
  const parsed = parseColour(words(value, 64, field))
  return parsed ? colourText(parsed) : invalid(field)
}

function paragraph(value: Fields, nullable: boolean): ParagraphChange {
  const out: ParagraphChange = {}
  if ('style' in value) out.style = nameOf(value.style, 'paragraph.style')
  if ('align' in value) out.align = oneOf(value.align, ALIGNMENTS, 'align')
  for (const key of Object.keys(PARA_NUMBERS) as (keyof typeof PARA_NUMBERS)[]) {
    if (!(key in value)) continue
    const [min, max] = PARA_NUMBERS[key]
    out[key] = nullable && value[key] === null ? null : number(value[key], min, max, key)
  }
  for (const key of ['keepWithNext', 'pageBreakBefore'] as const) if (key in value) out[key] = boolean(value[key], key)
  return out
}

function target(value: unknown): FormatTarget {
  const on = fields(value, ['quote', 'blocks', 'styled', 'all'], 'on')
  if (Object.keys(on).length !== 1) return invalid('on')
  if ('quote' in on) return { quote: words(on.quote, 2000, 'on.quote') }
  if ('styled' in on) return { styled: nameOf(on.styled, 'on.styled') }
  if (on.all === true) return { all: true }
  if ('blocks' in on && Array.isArray(on.blocks) && on.blocks.length > 0 && on.blocks.length <= 1000) return { blocks: on.blocks.map((id) => words(id, 128, 'on.blocks')) }
  return invalid('on')
}

function text(value: unknown): FormatChange {
  const input = fields(value, ['target', 'run', 'paragraph'], 'text')
  const out: FormatChange = { target: target(input.target) }
  if ('run' in input) {
    const r = nonempty(fields(input.run, ['font', 'size', 'color', 'highlight', 'bold', 'italic', 'underline'], 'run'), 'run')
    const run: RunChange = {}
    if ('font' in r) run.font = r.font === null ? null : font(r.font, 'run.font')
    if ('size' in r) run.size = r.size === null ? null : number(r.size, 1, 400, 'run.size')
    for (const key of ['color', 'highlight'] as const) if (key in r) run[key] = r[key] === null ? null : colour(r[key], key)
    for (const key of ['bold', 'italic', 'underline'] as const) if (key in r) run[key] = boolean(r[key], key)
    out.run = run
  }
  if ('paragraph' in input) out.paragraph = paragraph(nonempty(fields(input.paragraph,
    ['style', 'align', ...Object.keys(PARA_NUMBERS), 'keepWithNext', 'pageBreakBefore'], 'paragraph'), 'paragraph'), true)
  if (!out.run && !out.paragraph) return invalid('text')
  return out
}

function style(value: unknown) {
  const s = fields(value, ['name', 'basedOn', 'next', 'fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'color',
    'align', ...Object.keys(PARA_NUMBERS), 'keepWithNext'], 'style')
  const name = nameOf(s.name, 'style.name')
  const out: Fields = { name, ...paragraph(s, false) }
  for (const key of ['basedOn', 'next'] as const) if (key in s) out[key] = nameOf(s[key], key)
  if (out.basedOn === name) return invalid('style.basedOn')
  if ('fontFamily' in s) out.fontFamily = font(s.fontFamily, 'fontFamily')
  if ('fontSize' in s) out.fontSize = number(s.fontSize, 1, 400, 'fontSize')
  if ('color' in s) out.color = colour(s.color, 'style.color')
  for (const key of ['bold', 'italic', 'underline'] as const) if (key in s) out[key] = boolean(s[key], key)
  return cleanStyle(out) ?? invalid('style')
}

function theme(value: unknown) {
  const t = fields(value, ['name', 'colours', 'fonts'], 'theme')
  nameOf(t.name, 'theme.name')
  fields(t.colours, THEME_SLOTS, 'theme.colours')
  const fonts = fields(t.fonts, ['heading', 'body'], 'theme.fonts')
  font(fonts.heading, 'theme.fonts.heading')
  font(fonts.body, 'theme.fonts.body')
  return cleanTheme(t) ?? invalid('theme')
}

function setup(value: unknown): NonNullable<DocFormat['setup']> {
  const s = nonempty(fields(value, ['paper', 'orientation', 'columns', 'header', 'footer', 'differentFirst', 'margins'], 'setup'), 'setup')
  if ('paper' in s) oneOf(s.paper, PAPER_NAMES, 'setup.paper')
  if ('orientation' in s) oneOf(s.orientation, ['portrait', 'landscape'], 'setup.orientation')
  if ('columns' in s && !Number.isInteger(number(s.columns, 1, 4, 'setup.columns'))) return invalid('setup.columns')
  for (const key of ['header', 'footer', 'differentFirst'] as const) if (key in s) boolean(s[key], key)
  const margins = 'margins' in s ? nonempty(fields(s.margins, SIDES, 'setup.margins'), 'setup.margins') : undefined
  if (margins) for (const [key, amount] of Object.entries(margins)) number(amount, 0, 200, `setup.margins.${key}`)
  const clean = cleanSetup(s)
  // Keep only what the caller set, so a partial patch does not reset other fields.
  return Object.fromEntries(Object.keys(s).map((key) => [key, key === 'margins'
    ? Object.fromEntries(Object.keys(margins!).map((side) => [side, clean.margins[side as keyof typeof clean.margins]]))
    : clean[key as keyof typeof clean]]))
}

function band(value: unknown, name: string) {
  const b = fields(value, BANDS, name)
  for (const key of BANDS) {
    const runs = b[key]
    if (!Array.isArray(runs) || runs.length > 40) return invalid(name + '.' + key)
    for (const run of runs) {
      const part = fields(run, ['text', 'field'], name)
      if (Object.keys(part).length !== 1) return invalid(name)
      if ('text' in part) {
        if (typeof part.text !== 'string' || !part.text.length || part.text.length > 400) return invalid(name)
      } else oneOf(part.field, BAND_FIELDS, name)
    }
  }
  return cleanBand(b)
}

/** The socket accepts only the formatting fields the model can hold. */
function docFormatOf(value: unknown): DocFormat {
  const f = nonempty(fields(value, ['text', 'style', 'theme', 'setup', 'header', 'footer'], 'change'), 'change')
  const change: DocFormat = {}
  if ('text' in f) change.text = text(f.text)
  if ('style' in f) change.style = style(f.style)
  if ('theme' in f) change.theme = theme(f.theme)
  if ('setup' in f) change.setup = setup(f.setup)
  for (const key of ['header', 'footer'] as const) if (key in f) change[key] = band(f[key], key)
  return change
}

export function formatRouteFields(body: Fields) {
  fields(body, ['docId', 'file', 'fence', 'shared', 'principal', 'suggest', 'because', 'change', 'paper'], 'request')
  if ((body.docId === undefined) === (body.file === undefined)) return invalid('target')
  if ('docId' in body && (typeof body.docId !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(body.docId))) return invalid('docId')
  for (const key of ['shared', 'suggest'] as const) if (key in body) boolean(body[key], key)
  const fence = fields(body.fence, ['sectors', 'botId', 'client', 'draftOnly'], 'fence')
  for (const key of ['botId', 'client'] as const) if (key in fence) words(fence[key], 128, `fence.${key}`)
  if ('draftOnly' in fence) boolean(fence.draftOnly, 'fence.draftOnly')
  if (fence.sectors !== 'all' && (!Array.isArray(fence.sectors) || fence.sectors.length > 1000 ||
    fence.sectors.some((s) => typeof s !== 'string' || !s.trim() || s.length > 128))) return invalid('fence')
  return {
    because: oneOf(body.because, ['asked', 'routine', 'own'], 'because'),
    change: docFormatOf(body.change),
    ...(body.paper !== undefined ? { paper: oneOf(body.paper, PAPER_NAMES, 'paper') } : {})
  }
}
