// bun scripts/settings-map.ts
// Prints "where each old setting went" from the one map Settings is drawn from (src/renderer/src/lib/settings/map.ts):
// the table of the landing note and of docs/agents/settings.md, so neither can drift from the pages.
import { SETTINGS_SECTIONS } from '../src/renderer/src/lib/settings'
import { SETTINGS_MAP, settingWords, type SettingEntry, type SettingPage } from '../src/renderer/src/lib/settings/map'

const PAGE_NAME: Record<string, string> = { 'computer:*': 'A computer', job: 'A job', workspace: 'A workspace' }
const pageName = (page: SettingPage): string => PAGE_NAME[page] ?? SETTINGS_SECTIONS.find((section) => section.id === page)?.label ?? page
const vars = { computer: '<computer>', n: 'N', version: '' }
const home = (entry: SettingEntry): string => [pageName(entry.page), entry.section ? settingWords(entry.section, vars) : '', settingWords(entry.title, vars)].filter((part, i, all) => part && part !== all[i - 1]).join(' › ')
const KEPT: Record<SettingEntry['store'], string> = { ls: 'this app', host: 'that computer', box: 'the box', ws: 'the workspace', lifeos: 'LifeOS', none: '' }

/** One row per old home; a row with no old home is new in Settings 2. */
export function settingsMapTable(): string {
  const lines = ['| Was | Now | Kept in |', '| --- | --- | --- |']
  for (const entry of SETTINGS_MAP) {
    const olds = entry.was.length ? entry.was : ['(new)']
    for (const old of olds) lines.push(`| ${old} | ${home(entry)} | ${KEPT[entry.store]} |`)
  }
  return lines.join('\n')
}

if (import.meta.main) console.log(settingsMapTable())
