import { z } from 'zod'
import { THEME_SLOTS } from 'work-kit/format/theme'
import { ALIGNMENTS, BAND_FIELDS, PAPER_NAMES } from './formatInput'

const style = z.string().trim().min(1).max(120)
const font = z.string().trim().min(1).max(80)
const colour = z.string().trim().min(1).max(64).describe('RGB like #0F4761, or a theme colour like theme:accent1.')
const booleans = { bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional() }
const spacing = {
  lineSpacing: z.number().min(0.5).max(10),
  spaceBefore: z.number().min(0).max(1584),
  spaceAfter: z.number().min(0).max(1584),
  indent: z.number().min(0).max(1584),
  firstLine: z.number().min(-1584).max(1584)
}
const margin = z.number().min(0).max(200).optional()
const bandRun = z.union([z.strictObject({ text: z.string().min(1).max(400) }), z.strictObject({ field: z.enum(BAND_FIELDS) })])
const band = z.strictObject({ start: z.array(bandRun).max(40), center: z.array(bandRun).max(40), end: z.array(bandRun).max(40) })

export const docFormatFields = {
  on: z.union([
    z.strictObject({ quote: z.string().trim().min(1).max(2000) }),
    z.strictObject({ blocks: z.array(z.string().min(1).max(128)).min(1).max(1000) }),
    z.strictObject({ styled: style }),
    z.strictObject({ all: z.literal(true) })
  ]).optional().describe('The text to format. Leave it out when changing only styles, theme or page settings.'),
  run: z.strictObject({
    ...booleans, font: font.nullable().optional(), size: z.number().min(1).max(400).nullable().optional(),
    color: colour.nullable().optional(), highlight: colour.nullable().optional()
  }).optional(),
  paragraph: z.strictObject({
    style: style.optional(), align: z.enum(ALIGNMENTS).optional(),
    lineSpacing: spacing.lineSpacing.nullable().optional(), spaceBefore: spacing.spaceBefore.nullable().optional(),
    spaceAfter: spacing.spaceAfter.nullable().optional(), indent: spacing.indent.nullable().optional(), firstLine: spacing.firstLine.nullable().optional(),
    keepWithNext: z.boolean().optional(), pageBreakBefore: z.boolean().optional()
  }).optional(),
  style: z.strictObject({
    name: style, basedOn: style.optional(), next: style.optional(),
    fontFamily: font.optional(), fontSize: z.number().min(1).max(400).optional(), ...booleans,
    color: colour.optional(), align: z.enum(ALIGNMENTS).optional(),
    lineSpacing: spacing.lineSpacing.optional(), spaceBefore: spacing.spaceBefore.optional(), spaceAfter: spacing.spaceAfter.optional(),
    indent: spacing.indent.optional(), firstLine: spacing.firstLine.optional(), keepWithNext: z.boolean().optional()
  }).optional(),
  theme: z.strictObject({
    name: style, colours: z.record(z.enum(THEME_SLOTS), z.string().regex(/^[0-9a-f]{6}$/i)),
    fonts: z.strictObject({ heading: font, body: font })
  }).optional(),
  setup: z.strictObject({
    paper: z.enum(PAPER_NAMES).optional(), orientation: z.enum(['portrait', 'landscape']).optional(), columns: z.number().int().min(1).max(4).optional(),
    header: z.boolean().optional(), footer: z.boolean().optional(), differentFirst: z.boolean().optional(),
    margins: z.strictObject({ top: margin, right: margin, bottom: margin, left: margin }).optional().describe('Margins in points, 72 points per inch.')
  }).optional(),
  header: band.optional(),
  footer: band.optional(),
  because: z.enum(['asked', 'routine', 'own']),
  quote: z.string().max(2000).optional().describe('With "asked": the owner’s words in this thread asking for the change.')
}
