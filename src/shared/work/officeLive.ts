import type { CanvasSource } from './canvas'

/** A Files tab's item shown live in Word, Excel or PowerPoint on the web: a Microsoft file named by its address. */
export const isLiveSource = (source: CanvasSource): source is Extract<CanvasSource, { at: 'microsoft' }> & { ref: { kind: 'url'; url: string } } =>
  source.at === 'microsoft' && source.ref.kind === 'url'

/**
 * What a window asks main for to open a Microsoft form live (src/main/officeLive.ts `formsTicketOf`): the tenant whose
 * session it runs in, the form's id and which page. Never an address: main makes the builder's or response page's.
 */
export interface FormsLiveAsk {
  tenant: string
  formId: string
  page: 'design' | 'respond'
}

/** A live guest's ask: a file's web address, or a form. */
export type LiveTicketAsk = string | { forms: FormsLiveAsk }
