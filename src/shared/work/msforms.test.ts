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
  PAYLOAD_UNREAD,
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

  it('finds a link spelled in HTML character references, named, decimal or hex, and in percent-escapes', () => {
    const named = `<a href="https&colon;&sol;&sol;forms&period;office&period;com&sol;r&sol;AbC123xyz">go</a>`
    const decimal = `<a href="&#104;&#116;&#116;&#112;&#115;&#58;&#47;&#47;&#102;&#111;&#114;&#109;&#115;&#46;&#111;&#102;&#102;&#105;&#99;&#101;&#46;&#99;&#111;&#109;&#47;&#114;&#47;AbC123xyz">go</a>`
    const hex = `https:&#x2F;&#x2f;forms&#x2E;cloud&#x2E;microsoft/Pages/ResponsePage.aspx?id=${ID}`
    const percent = `https://forms%2Eoffice%2Ecom/Pages/ResponsePage%2Easpx%3Fid%3D${ID}`
    const twice = `https:&amp;#47;&amp;#47;forms.office.com/r/AbC123xyz`
    for (const text of [named, decimal, hex, percent, twice]) expect(hasFormLink(text), text).toBe(true)
  })

  it('compares hosts as a browser canonicalizes them: case, a trailing dot, a subdomain, a port, a userinfo, backslashes', () => {
    for (const text of [
      `HTTPS://FORMS.OFFICE.COM/PAGES/RESPONSEPAGE.ASPX?ID=${ID}`,
      `https://forms.office.com./r/AbC123xyz`,
      `https://eu.forms.office.com/Pages/ResponsePage.aspx?lang=en&id=${ID}`,
      `https://forms.office.com:443/r/AbC123xyz`,
      `https://someone@forms.office.com/r/AbC123xyz`,
      String.raw`https:\\forms.office.com\r\AbC123xyz`,
      `https://forms．office．com/r/AbC123xyz`
    ])
      expect(hasFormLink(text), text).toBe(true)
    // a look-alike host, a builder page, and a short link of another host are no answer link
    expect(hasFormLink('https://forms.office.com.example.com/r/AbC123xyz')).toBe(false)
    expect(hasFormLink(`https://forms&period;office&period;com/Pages/DesignPageV2.aspx?id=${ID}`)).toBe(false)
    expect(hasFormLink('https://example.com/r/AbC123xyz')).toBe(false)
  })

  it('answers yes for a payload it could not read whole, at its string or its depth cap', () => {
    const many = { parts: Array.from({ length: 500 }, (_, i) => `part ${i}`) }
    expect(payloadText(many)).toContain(PAYLOAD_UNREAD)
    expect(hasFormLink(payloadText(many))).toBe(true)
    let deep: unknown = 'the end'
    for (let i = 0; i < 12; i++) deep = { inner: deep }
    expect(hasFormLink(payloadText(deep))).toBe(true)
    // a payload read whole and clean is not
    expect(payloadText({ a: 'one', b: ['two'] })).toBe('one\ntwo')
    expect(hasFormLink(payloadText({ a: 'one', b: ['two'] }))).toBe(false)
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
    expect(changeWords({ op: 'add', question: night }, [name])).toBe('Add a Choice “Which night?” with Mon, Tue, Wed')
    expect(changeWords({ op: 'change', at: 0, question: { ...name, title: 'Full name' } }, [name])).toBe('Rename “Name” to “Full name”')
    expect(changeWords({ op: 'remove', at: 0 }, [name])).toBe('Remove “Name”')
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
    expect(diffQuestions(before, after)).toEqual(['Renamed “Name” to “Full name”', 'Added a Date “When?”, required'])
    expect(diffQuestions(after, before)).toEqual(['Removed “When?”', 'Renamed “Full name” to “Name”'])
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
