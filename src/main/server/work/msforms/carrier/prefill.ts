import { formIdOf } from '@shared/work/msforms'
import { click, one, type Page } from './steps'
import { CarrierStop } from './types'

/**
 * A prefilled link (docs/agents/work-msforms.md "Sharing"): More form
 * settings → Get Pre-filled URL, the values he typed into the questions they
 * name, then the link Forms makes. The link is read, never sent or copied out.
 * Each value goes into the field whose question title is its key.
 */
export async function prefillLink(page: Page, formId: string, values: Record<string, string>, mount: number): Promise<{ link: string }> {
  await page.act((x) => {
    const more = one(x, ['button', 'menu button'], /^More form settings$/i)
    return more ? [click(more)] : null
  }, 'More form settings')
  await page.act((x) => {
    const item = one(x, ['menu item', 'button'], /^Get Pre-?filled URL$/i)
    return item ? [click(item)] : null
  }, 'Get Pre-filled URL')
  const start = one(page.last!, ['button'], /^Start Now$/i)
  if (start) await page.act((x) => {
    const b = one(x, ['button'], /^Start Now$/i)
    return b ? [click(b)] : []
  }, 'Start Now')
  for (const [title, value] of Object.entries(values)) {
    await page.act((x) => {
      const field = [...x.elements.values()].find((e) => (e.role === 'input' || e.role === 'text area') && (e.name ?? '').includes(title))
      return field ? [{ action: 'type', element: field.index, text: value } as never, { action: 'key', element: field.index, text: 'Tab' } as never] : null
    }, `the answer to "${title}"`)
  }
  await page.act((x) => {
    const b = one(x, ['button'], /^Get Prefilled Link$/i)
    return b ? [click(b)] : null
  }, 'Get Prefilled Link')
  const { got } = await page.until((x) => [...x.elements.values()].find((e) => e.role === 'input' && formIdOf(e.value ?? '') === formId)?.value ?? null, mount)
  if (!got) throw new CarrierStop('Forms did not show a prefilled link.', null, formId)
  return { link: got }
}
