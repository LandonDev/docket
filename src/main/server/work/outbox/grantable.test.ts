import { describe, expect, it } from 'vitest'
import { NO_GRANT_FROM_CONSOLE, NO_GRANT_FROM_FORM_LINK, notGrantable, notGrantableWords } from './outbox'

/** An act the host read in a command line (outward.ts consoleRead) is one no grant may cover. */
describe('an act no grant may cover', () => {
  it('is one whose read says so, and only that', () => {
    expect(notGrantable({ read: { step: 0, why: 'console', label: 'Run', on: 'text "dir" in Terminal', grantable: false } })).toBe(true)
    expect(notGrantable({ read: { step: 0, why: 'control', label: 'Send', on: 'button "Send"' } })).toBe(false)
    expect(notGrantable({ read: null })).toBe(false)
    expect(notGrantable(null)).toBe(false)
    expect(NO_GRANT_FROM_CONSOLE).toMatch(/^refused: /)
  })
})

/** A Microsoft form's link reaches people only on his press (shared/work/msforms.ts `hasFormLink`). */
describe("an act that carries a Microsoft form's link", () => {
  const respond = 'https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=AbCdEfGhIjKlMnOpQrStUvWx'
  const mail = (text: string, html = `<p>${text}</p>`) => ({ id: 'ob_1', status: 'draft', message: { kind: 'mail', accountId: 'a', to: [{ address: 'dana@purdue.edu' }], subject: 'Sign up', text, html } })
  const reply = (text: string) => ({ chatId: 'ch_1', source: 'slack', chat: 'Esports staff', text })

  it('is no grant\'s, whatever its kind: a mail.send by its text or its html, a chat.reply, a short link', () => {
    expect(notGrantable(mail(`Answer here: ${respond}`))).toBe(true)
    expect(notGrantable(mail('Answer here.', `<a href="${respond.replace('?', '?lang=en&amp;')}">the form</a>`))).toBe(true)
    expect(notGrantable(reply(`Sign up: ${respond}`))).toBe(true)
    expect(notGrantable(reply('Sign up: forms.office.com/r/Ab12Cd34'))).toBe(true)
    expect(notGrantableWords(reply(respond))).toBe(NO_GRANT_FROM_FORM_LINK)
    expect(NO_GRANT_FROM_FORM_LINK).toMatch(/^refused: /)
  })

  it('is not one with no such link: the builder, another host, plain words', () => {
    expect(notGrantable(mail('See you Friday.'))).toBe(false)
    expect(notGrantable(reply('Sign up at https://example.com/Pages/ResponsePage.aspx?id=AbCdEfGhIjKlMnOpQrStUvWx'))).toBe(false)
    expect(notGrantable(reply('I am editing https://forms.cloud.microsoft/Pages/DesignPageV2.aspx?subpage=design&id=AbCdEfGhIjKlMnOpQrStUvWx'))).toBe(false)
    expect(notGrantableWords({ read: { grantable: false } })).toBe(NO_GRANT_FROM_CONSOLE)
  })
})
