/**
 * The app's names. APP_NAME is the one a person reads in the app's own words:
 * titles, dialogs, notices, prompts. OS_APP_NAME is the one the OS and other
 * programs still show, from the bundle (electron-builder.yml productName):
 * the Dock, /Applications, System Settings' privacy lists, the Start menu.
 * Words that send the person to one of those places name OS_APP_NAME.
 * src/shared/appName.test.ts refuses a new literal of the old name in shown text.
 */
export const APP_NAME = 'Docket'
export const OS_APP_NAME = 'TempCode'
