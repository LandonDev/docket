/**
 * The app's names. APP_NAME is the one a person reads in the app's own words:
 * titles, dialogs, notices, prompts. OS_APP_NAME is the one the OS and other
 * programs show, from the bundle (electron-builder.yml productName):
 * the Dock, /Applications, System Settings' privacy lists, the Start menu.
 * Words that send the person to one of those places name OS_APP_NAME.
 * src/shared/appName.test.ts refuses a new literal of the old name in shown text.
 */
export const APP_NAME = 'Docket'
export const OS_APP_NAME = 'Docket'
/**
 * Every name the OS has known this app's bundle, program and process by, the new one first: a
 * reader that recognises the app by name (its own window refused to computer use, appshots'
 * exclusions, the scripts that find an install) accepts each, since an install made before the
 * rename keeps its old name until it is installed again.
 */
export const KNOWN_APP_NAMES = ['Docket', 'TempCode'] as const
