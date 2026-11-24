import type { CanvasSource } from './canvas'

/** A Files tab's item shown live in Word, Excel or PowerPoint on the web: a Microsoft file named by its address. */
export const isLiveSource = (source: CanvasSource): source is Extract<CanvasSource, { at: 'microsoft' }> & { ref: { kind: 'url'; url: string } } =>
  source.at === 'microsoft' && source.ref.kind === 'url'
