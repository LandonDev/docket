import core from '../../../../../../addins/office/core.js?raw'
import icon32 from '../../../../../../addins/office/icon-32.png.b64?raw'
import icon64 from '../../../../../../addins/office/icon-64.png.b64?raw'
import icon80 from '../../../../../../addins/office/icon-80.png.b64?raw'
import manifest from '../../../../../../addins/office/manifest.xml?raw'
import taskpane from '../../../../../../addins/office/taskpane.html?raw'
import taskpaneJs from '../../../../../../addins/office/taskpane.js?raw'

/**
 * The add-in's files (addins/office), built into the Work service so it
 * serves them at `/w/addin/<name>` with no folder to ship beside it.
 */
export const ADDIN_ASSETS: Record<string, { type: string; body: string | Buffer }> = {
  'taskpane.html': { type: 'text/html; charset=utf-8', body: taskpane },
  'taskpane.js': { type: 'text/javascript; charset=utf-8', body: taskpaneJs },
  'core.js': { type: 'text/javascript; charset=utf-8', body: core },
  'manifest.xml': { type: 'application/xml; charset=utf-8', body: manifest },
  'icon-32.png': { type: 'image/png', body: Buffer.from(icon32.trim(), 'base64') },
  'icon-64.png': { type: 'image/png', body: Buffer.from(icon64.trim(), 'base64') },
  'icon-80.png': { type: 'image/png', body: Buffer.from(icon80.trim(), 'base64') }
}

/** The add-in's working part as text: the proofs run it against a stub Office.js. */
export const ADDIN_CORE = core
