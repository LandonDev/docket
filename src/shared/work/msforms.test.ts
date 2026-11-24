import { describe, expect, it } from 'vitest'
import {
  applyChange,
  builderOf,
  changeWords,
  diffQuestions,
  formIdOf,
  fromOurQuestion,
  hasFormLink,
  isFormsHost,
  payloadText,
  respondOf,
  widens,
  workbookNameOf,
  type MsAnyQuestion,
  type MsQuestion
} from './msforms'

const ID = 'Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrFVrNURDVET1gyWlpLNkJXOUsyWEJXNFlKMzMxVC4u'

describe('Forms hosts and addresses', () => {
  it('knows Forms hosts and their subdomains, and nothing near them', () => {
    expect(isFormsHost('forms.office.com')).toBe(true)
    expect(isFormsHost('Forms.Cloud.Microsoft')).toBe(true)
    expect(isFormsHost('hive.forms.cloud.microsoft')).toBe(true)
    expect(isFormsHost('office.com')).toBe(false)
    expect(isFormsHost('notforms.office.com')).toBe(false)
    expect(isFormsHost('forms.office.com.evil.example')).toBe(false)
  })

  it('makes the builder and response addresses from an id alone', () => {
    expect(builderOf(ID)).toBe(`https://forms.cloud.microsoft/Pages/DesignPageV2.aspx?subpage=design&id=${ID}`)
    expect(respondOf(ID)).toBe(`https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${ID}`)
    expect(() => builderOf('x&Action=Create')).toThrow()
    expect(formIdOf(respondOf(ID))).toBe(ID)
    expect(formIdOf(`https://example.com/Pages/ResponsePage.aspx?id=${ID}`)).toBeNull()
  })

  it('finds a form link in both forms, in words or a payload', () => {
    expect(hasFormLink(`Please answer: ${respondOf(ID)} thanks`)).toBe(true)
    expect(hasFormLink(`https://forms.office.com/Pages/ResponsePage.aspx?embed=true&amp;id=${ID}`)).toBe(true)
    expect(hasFormLink('fill it in at forms.office.com/r/AbC123xyz')).toBe(true)
    expect(hasFormLink('https://forms.cloud.microsoft/r/Zk3q9')).toBe(true)
    expect(hasFormLink(builderOf(ID))).toBe(false)
    expect(hasFormLink('the forms are on the desk')).toBe(false)
    expect(hasFormLink(payloadText({ to: ['a@b.c'], body: { html: `<a href="${respondOf(ID)}">go</a>` } }))).toBe(true)
  })
})

describe('questions', () => {
  const name: MsQuestion = { title: 'Name', type: 'text', required: true }
  const night: MsQuestion = { title: 'Which night?', type: 'choice', options: ['Mon', 'Tue', 'Wed'], required: false }

  it('maps our form types', () => {
    expect(fromOurQuestion({ label: 'Notes', type: 'long' })).toEqual({ title: 'Notes', type: 'text', long: true, required: false })
    expect(fromOurQuestion({ label: 'Size', type: 'dropdown', options: ['S', 'M'], required: true })).toEqual({ title: 'Size', type: 'choice', dropdown: true, options: ['S', 'M'], required: true })
    expect(fromOurQuestion({ label: 'Part 2', type: 'section', required: true }).required).toBe(false)
  })

  it('says a change in words', () => {
    expect(changeWords({ op: 'add', question: night }, [name])).toBe('Add a Choice "Which night?" with Mon, Tue, Wed')
    expect(changeWords({ op: 'change', at: 0, question: { ...name, title: 'Full name' } }, [name])).toBe('Rename "Name" to "Full name"')
    expect(changeWords({ op: 'remove', at: 0 }, [name])).toBe('Remove "Name"')
  })

  it('applies changes and keeps a ref on change', () => {
    const list: MsAnyQuestion[] = [{ ...name, ref: 'r1' }]
    expect(applyChange(list, { op: 'change', at: 0, question: { ...name, title: 'Full name' } })[0]).toMatchObject({ ref: 'r1', title: 'Full name' })
    expect(applyChange(list, { op: 'add', question: night, after: -1 })[0].title).toBe('Which night?')
    expect(() => applyChange(list, { op: 'remove', at: 3 })).toThrow('no question 4')
    expect(() => applyChange([{ title: 'Rank', type: 'other', kind: 'Ranking' }], { op: 'change', at: 0, question: name })).toThrow('only the Forms page')
  })

  it('diffs two lists by ref, then by title', () => {
    const before: MsAnyQuestion[] = [{ ...name, ref: 'r1' }, { ...night, ref: 'r2' }]
    const after: MsAnyQuestion[] = [{ ...name, ref: 'r1', title: 'Full name' }, { ...night, ref: 'r2' }, { title: 'When?', type: 'date', required: true }]
    expect(diffQuestions(before, after)).toEqual(['Renamed "Name" to "Full name"', 'Added a Date "When?", required'])
    expect(diffQuestions(after, before)).toEqual(['Removed "When?"', 'Renamed "Full name" to "Name"'])
    expect(diffQuestions(before, [before[1], before[0]])).toEqual(['Moved questions'])
    expect(diffQuestions(before, before)).toEqual([])
  })
})

describe('settings and the workbook', () => {
  it('widening is only org-only turned off', () => {
    expect(widens({ orgOnly: true }, { orgOnly: false })).toBe(true)
    expect(widens({ orgOnly: false }, { orgOnly: true })).toBe(false)
    expect(widens({ orgOnly: true }, {})).toBe(false)
  })

  it('names the workbook after the title', () => {
    expect(workbookNameOf('Intramural sign-up')).toBe('Intramural sign-up.xlsx')
    expect(workbookNameOf('a/b: c?')).toBe('a b c.xlsx')
  })
})
