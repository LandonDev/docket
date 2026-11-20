/**
 * A file's name made safe to write: Mail's Save to Downloads (src/main/downloads.ts) and an
 * attachment the host keeps for a canvas item (work/canvas/fetch.ts). The name is the sender's.
 */

/** A file name with nothing in it a file system or a shell would read as more than a name. */
export function safeFileName(name: string): string {
  const cleaned = String(name)
    // Marks that turn text round or hide in it: with them "exe.fdp" can read as "pdf.exe" in a file list.
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    // Path separators, control characters, and what Windows refuses in a name.
    .replace(/[\\/\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
    .trim()
  const kept = clip(cleaned)
  return kept && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(kept) ? kept : 'file'
}

/** The longest a saved name may be. */
const NAME_MAX = 180

/**
 * A long name cut to fit, from its stem: the last extension is what says what the file is, so it
 * is never the part that goes. Cut from the end, "report … .exe.txt" would be saved as an .exe.
 */
function clip(name: string): string {
  if (name.length <= NAME_MAX) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 20 ? name.slice(dot) : ''
  const stem = name.slice(0, NAME_MAX - ext.length).replace(/[. ]+$/, '')
  // With no extension short enough to keep, the cut may not make one: a dot left near the end
  // ("… .exe" out of "… .exe.<long tail>") would name a type the file never claimed.
  return ext ? `${stem}${ext}` : stem.replace(/\./g, '_')
}

/** `name` if free, else "name (1).ext", "name (2).ext", … as a browser numbers a second download. */
export function freeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 1; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
  throw new Error('too many files with that name')
}
