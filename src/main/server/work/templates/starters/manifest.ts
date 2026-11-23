import { ANY_SECTOR, starterSlug, type TemplateKind } from '@shared/work/templates'

/**
 * Our starter templates (docs/agents/work-templates.md "The starters"):
 * what each file is and the fields it asks for. The build
 * (scripts/build-work-templates.ts) writes one file per entry into
 * `resources/work-templates/<sector>/<Name>.<form>`, and starters.test.ts
 * holds the checked-in files to this list. A starter's name IS its file's
 * name; its slug and key come from the name.
 *
 * `fields` are the asked fields in the file's order: never Date, Name or
 * Job, which are filled without asking.
 */

export const STARTER_SECTORS = ['cosmic', 'hypixel', 'purdue', 'ref', 'unify', 'life', ANY_SECTOR] as const
export type StarterSector = (typeof STARTER_SECTORS)[number]

export type StarterForm = 'docx' | 'xlsx' | 'pptx'

export interface Starter {
  sector: StarterSector
  slug: string
  name: string
  kind: TemplateKind
  form: StarterForm
  fields: string[]
}

const FORM: Record<TemplateKind, StarterForm> = { document: 'docx', sheet: 'xlsx', deck: 'pptx' }
const entry = (sector: StarterSector, name: string, kind: TemplateKind, fields: string[] = []): Starter => ({ sector, slug: starterSlug(name), name, kind, form: FORM[kind], fields })

export const STARTERS: readonly Starter[] = [
  entry('cosmic', 'Release note', 'document', ['Version']),
  entry('cosmic', 'Incident report', 'document', ['Incident']),
  entry('cosmic', 'Release checklist', 'sheet', ['Version']),
  entry('cosmic', 'Update briefing', 'deck', ['Update']),
  entry('hypixel', 'Shot list', 'sheet', ['Video']),
  entry('hypixel', 'Video brief', 'document', ['Video']),
  entry('hypixel', 'Script', 'document', ['Video']),
  entry('hypixel', 'Review deck', 'deck', ['Video']),
  entry('purdue', 'Memo', 'document', ['To', 'Subject']),
  entry('purdue', 'Event run of show', 'document', ['Event']),
  entry('purdue', 'Travel budget', 'sheet', ['Trip']),
  entry('purdue', 'Program update', 'deck', ['Term']),
  entry('ref', 'Game report', 'document', ['Home', 'Away', 'Site']),
  entry('ref', 'Incident report', 'document', ['Home', 'Away']),
  entry('ref', 'Season log', 'sheet'),
  entry('unify', 'Invoice', 'sheet', ['Client', 'Invoice number']),
  entry('unify', 'Proposal', 'document', ['Client', 'Project']),
  entry('unify', 'Statement of work', 'document', ['Client', 'Project']),
  entry('unify', 'Pitch deck', 'deck', ['Client']),
  entry('life', 'Trip plan', 'document', ['Trip']),
  entry('life', 'Monthly budget', 'sheet'),
  entry('life', 'Checklist', 'document'),
  entry(ANY_SECTOR, 'Meeting notes', 'document', ['Meeting'])
]

/** A starter's key as a caller writes it: `unify/invoice`. */
export const starterKey = (s: Pick<Starter, 'sector' | 'slug'>): string => `${s.sector}/${s.slug}`

/** A starter's file under `resources/work-templates/`: `unify/Invoice.xlsx`. */
export const starterFile = (s: Pick<Starter, 'sector' | 'name' | 'form'>): string => `${s.sector}/${s.name}.${s.form}`
