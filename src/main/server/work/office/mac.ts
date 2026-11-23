import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { OFFICE_APPS, type OfficeAllowed, type OfficeApp, type OfficeCell } from '@shared/contract-work-office'
import { APP_NAMES, isPasswordLocked, lockedWords, OfficeError, type OfficeCarrier, type RenderApp, type RenderAsk, type RenderDone } from './carrier'
import { OSA_TIMEOUT_MS, OsaTimeout, runOsa, type Osa } from './osa'

/**
 * The Mac carrier (docs/agents/work-office.md "The Mac"): every verb is one
 * JXA script run by osascript, its arguments one JSON string, its answer
 * JSON. A range is one Apple Event each way, never one per cell.
 *
 * The names are the apps' own dictionaries (`sdef`), checked for Excel
 * 16.102 and Outlook 16.115: a range's `formula2`, `value`, `number format`;
 * a worksheet's `used range` with `first row index`; a workbook's `full
 * name`; Outlook's `outgoing message`, `reply to`, `forward`, `send`,
 * `calendar event`, `send meeting`, `accept meeting`. Word and PowerPoint
 * were not on the Mac to check: their scripts follow their published
 * dictionaries and are unproven until run.
 *
 * It drives the apps he started: a verb on an app that is not running
 * answers "not open" rather than starting it unseen, save `open` (the switch).
 */

const PRELUDE = `
// An app's collection answers null, not [], when it holds nothing (Excel open with no workbook).
function all(x){ return x == null ? [] : x }
function app(name){ var a = Application(name); if (!a.running()) throw new Error(name + ' is not open. (-600)'); return a }
function grid(x){ if (!Array.isArray(x)) return [[x]]; if (x.length && !Array.isArray(x[0])) return [x]; return x }
function cell(v){ if (v === undefined || v === null || v === '') return null; if (v instanceof Date) return v.toISOString(); return v }
function book(xl, key){ var bs = all(xl.workbooks()); for (var i = 0; i < bs.length; i++) if (bs[i].fullName() === key || bs[i].name() === key) return bs[i]; throw new Error('No open workbook ' + key + '. (-1728)') }
// Word gives a document's full name as an HFS path ("Macintosh HD:private:tmp:a.docx"); Excel and PowerPoint as a POSIX one.
// Keys are POSIX everywhere, and a key matches either form, /tmp and /private/tmp alike.
function posix(n){ n = String(n); if (!/^[^\\/:]+:/.test(n) || /^https?:/i.test(n)) return n;
  var parts = n.split(':'), vol = parts.shift(); ObjC.import('Foundation'); var boot = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath('/'));
  return (vol === boot ? '' : '/Volumes/' + vol) + '/' + parts.map(function(c){ return c.replace(/\\//g, ':') }).join('/') }
function same(a, b){ var t = function(x){ return String(x).replace(/^\\/private(?=\\/(tmp|var|etc)\\/)/, '') }; return t(a) === t(b) }
function byKey(coll, key){ var n = coll.length || 0; for (var i = 0; i < n; i++) { var x = coll[i]; if (same(posix(x.fullName()), key) || x.name() === key) return x } throw new Error('Nothing open named ' + key + '. (-1728)') }
// Each text box of a deck, slide by slide and shape by shape; a shape with no text frame (a picture, a line) is passed over.
function eachText(p, fn){ for (var i = 0; i < p.slides.length; i++) { var sl = p.slides[i]; for (var k = 0; k < sl.shapes.length; k++) { var h = sl.shapes[k], t;
  try { if (!h.hasTextFrame()) continue; t = h.textFrame.textRange; t.content() } catch (e) { continue } fn(i, t) } } }
function files(list){ return all(list).map(function(f){ return { key: posix(f.fullName()), name: f.name() } }) }
function addr(m){ return m && m.address ? m.address : String(m || '') }
function account(o, address){ var accs = [].concat(all(o.exchangeAccounts()), all(o.imapAccounts()), all(o.popAccounts())); var acc = accs.filter(function(x){ return String(x.emailAddress()).toLowerCase() === address.toLowerCase() })[0];
  if (!acc) throw new Error('Outlook has no account ' + address + '. (-1728)'); return acc }
var ISO = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/
function out(x){ return x === null ? '' : typeof x === 'string' && ISO.test(x) ? new Date(x) : x }
`

const js = (body: string): string => `${PRELUDE}\nfunction run(argv){ var a = JSON.parse(argv[0] || '{}'); ${body} }`

/** Plain text as HTML that shows exactly that text: every character escaped, each line break a <br>. */
export function textAsHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n|\r|\n/g, '<br>')
}

export const SCRIPTS = {
  workbooks: js(`var xl = app('Microsoft Excel');
    return JSON.stringify(all(xl.workbooks()).map(function(b){ return { key: b.fullName(), name: b.name(), sheets: all(b.worksheets()).map(function(s){
      var u = s.usedRange; var r = u.rows.length, c = u.columns.length; if (r === 1 && c === 1 && cell(u.value()) === null) return { name: s.name(), rows: 0, columns: 0 };
      return { name: s.name(), rows: u.firstRowIndex() + r - 1, columns: u.firstColumnIndex() + c - 1 } }) } }))`),
  // A block's number format is one value, not a grid: the format when every cell shares it, "" when they
  // differ. Then by row, then by cell, as the Windows helper does.
  readRange: js(`var ws = book(app('Microsoft Excel'), a.book).worksheets.byName(a.sheet); var r = ws.ranges.byName(a.address);
    var v = grid(r.value()), f = grid(r.formula2()), nr = v.length, nc = v[0].length;
    var m = /^\\$?([A-Za-z]+)\\$?(\\d+)/.exec(a.address), c0 = 0, r0 = Number(m[2]);
    for (var k = 0; k < m[1].length; k++) c0 = c0 * 26 + m[1].toUpperCase().charCodeAt(k) - 64;
    function col(n){ var t = ''; while (n > 0) { t = String.fromCharCode(65 + (n - 1) % 26) + t; n = Math.floor((n - 1) / 26) } return t }
    function at(i, j, n, w){ return col(c0 + j) + (r0 + i) + (n * w > 1 ? ':' + col(c0 + j + w - 1) + (r0 + i + n - 1) : '') }
    var z = v.map(function(row){ return row.map(function(){ return '' }) });
    function fmts(rng, i, j, n, w){
      var g = grid(rng.numberFormat()), x, y;
      if (n * w === 1) { z[i][j] = g[0][0] == null ? '' : String(g[0][0]); return }
      if (g.length === n && g[0].length === w) { for (x = 0; x < n; x++) for (y = 0; y < w; y++) z[i + x][j + y] = g[x][y] == null ? '' : String(g[x][y]); return }
      if (g[0][0] != null && g[0][0] !== '') { for (x = 0; x < n; x++) for (y = 0; y < w; y++) z[i + x][j + y] = String(g[0][0]); return }
      if (n > 1) { for (x = 0; x < n; x++) fmts(ws.ranges.byName(at(i + x, j, 1, w)), i + x, j, 1, w); return }
      for (y = 0; y < w; y++) fmts(ws.ranges.byName(at(i, j + y, 1, 1)), i, j + y, 1, 1)
    }
    fmts(r, 0, 0, nr, nc);
    return JSON.stringify({ values: v.map(function(row){ return row.map(cell) }),
      formulas: f.map(function(row){ return row.map(function(x){ return typeof x === 'string' && x.charAt(0) === '=' ? x : '' }) }),
      formats: z })`),
  writeRange: js(`var r = book(app('Microsoft Excel'), a.book).worksheets.byName(a.sheet).ranges.byName(a.address);
    var g = a.grid.map(function(row){ return row.map(out) });
    var one = g.length === 1 && g[0].length === 1;
    if (a.formulas) r.formula2 = one ? String(g[0][0]) : g.map(function(row){ return row.map(String) }); else r.value = one ? g[0][0] : g;
    return 'null'`),
  documents: js(`return JSON.stringify(files(app('Microsoft Word').documents()))`),
  readDocument: js(`var d = byKey(app('Microsoft Word').documents, a.doc); return JSON.stringify(String(d.textObject.content()).split('\\r'))`),
  editDocument: js(`var w = app('Microsoft Word'); var d = byKey(w.documents, a.doc); var was = d.trackRevisions(); d.trackRevisions = a.tracked; var n = 0;
    try {
      if (a.edit.insert !== undefined) { var e = a.edit.at === 'start' ? 0 : Math.max(0, d.textObject.endOfContent() - 1); w.createRange(d, { start: e, end: e }).content = a.edit.insert; n = 1 }
      else { n = String(d.textObject.content()).split(a.edit.find).length - 1; if (n) w.executeFind(d.textObject.findObject, { findText: a.edit.find, replaceWith: a.edit.replace, replace: 'replace all', matchCase: true }) }
    } finally { d.trackRevisions = was }
    return JSON.stringify(n)`),
  presentations: js(`return JSON.stringify(files(app('Microsoft PowerPoint').presentations()))`),
  // PowerPoint answers one shape at a time, by index: a list read of slides or shapes, or of their text, fails or comes back null.
  readSlides: js(`var p = byKey(app('Microsoft PowerPoint').presentations, a.pres), out = [];
    eachText(p, function(i, t){ (out[i] = out[i] || { index: i + 1, texts: [] }).texts.push(String(t.content())) });
    for (var i = 0; i < p.slides.length; i++) out[i] = out[i] || { index: i + 1, texts: [] };
    return JSON.stringify(out)`),
  replaceSlideText: js(`var p = byKey(app('Microsoft PowerPoint').presentations, a.pres), n = 0;
    eachText(p, function(i, t){ var c = String(t.content()); if (c.indexOf(a.find) >= 0) { t.content = c.split(a.find).join(a.replace); n++ } });
    return JSON.stringify(n)`),
  accounts: js(`var o = app('Microsoft Outlook'); var accs = [].concat(all(o.exchangeAccounts()), all(o.imapAccounts()), all(o.popAccounts()));
    return JSON.stringify(accs.map(function(x){ return String(x.emailAddress()) }).filter(Boolean))`),
  listMail: js(`var o = app('Microsoft Outlook'); var f = a.folder === 'sent' ? o.sentItems : a.folder === 'drafts' ? o.drafts : o.inbox;
    var ms = a.query ? f.messages.whose({ subject: { _contains: a.query } }) : f.messages; var n = Math.min(ms.length || 0, a.limit), out = [];
    for (var i = 0; i < n; i++) { var m = ms[i]; out.push({ id: String(m.id()), account: String(m.account.emailAddress()), from: addr(m.sender()), subject: String(m.subject()), at: (m.timeReceived() || m.timeSent() || new Date(0)).toISOString(), read: !!m.isRead() }) }
    return JSON.stringify(out)`),
  readMail: js(`var o = app('Microsoft Outlook'); var m = o.messages.byId(Number(a.id));
    var rs = function(list){ return all(list).map(function(r){ return addr(r.emailAddress()) }) };
    return JSON.stringify({ id: String(m.id()), account: String(m.account.emailAddress()), from: addr(m.sender()), subject: String(m.subject()), at: (m.timeReceived() || m.timeSent() || new Date(0)).toISOString(), read: !!m.isRead(),
      to: rs(m.toRecipients()), cc: rs(m.ccRecipients()), text: String(m.plainTextContent()) })`),
  mail: js(`var o = app('Microsoft Outlook'); var m;
    if (a.m.replyTo) { m = o.replyTo(o.messages.byId(Number(a.m.replyTo)), { openingWindow: false, replyToAll: false }); m.content = a.m.html + String(m.content()) }
    else if (a.m.forward) { m = o.forward(o.messages.byId(Number(a.m.forward)), { to: a.m.to.join(','), openingWindow: false }); m.content = a.m.html + String(m.content()) }
    else {
      var props = { subject: a.m.subject, content: a.m.html };
      if (a.m.account) props.account = account(o, a.m.account);
      m = o.OutgoingMessage(props); o.outgoingMessages.push(m) }
    // A reply he pressed goes to the held To alone: what Outlook addressed it to (the mail's Reply-To, say) is taken off first.
    var answer = a.send && (a.m.replyTo || a.m.forward);
    if (a.send && a.m.replyTo) [m.toRecipients, m.ccRecipients, m.bccRecipients].forEach(function(list){ all(list()).forEach(function(r){ try { o.delete(r) } catch (e) {} }) });
    if (!a.m.forward && (!a.m.replyTo || a.send)) a.m.to.forEach(function(x){ m.toRecipients.push(o.ToRecipient({ emailAddress: { address: x } })) });
    a.m.cc.forEach(function(x){ m.ccRecipients.push(o.CcRecipient({ emailAddress: { address: x } })) });
    a.m.bcc.forEach(function(x){ m.bccRecipients.push(o.BccRecipient({ emailAddress: { address: x } })) });
    // Then what Outlook holds is read back (the hold review's 21.1, as carrier.ts recipientsOff): anyone but the held
    // recipients, or one of them missing, and the mail is thrown away unsent.
    if (answer) {
      var norm = function(xs){ var seen = {}; return xs.map(function(x){ return String(x).trim().toLowerCase() }).filter(function(x){ if (!x || seen[x]) return false; seen[x] = true; return true }).sort() };
      var read = function(list){ return all(list()).map(function(r){ return addr(r.emailAddress()) }) };
      var built = { to: read(m.toRecipients), cc: read(m.ccRecipients), bcc: read(m.bccRecipients) };
      var names = { to: 'To', cc: 'Cc', bcc: 'Bcc' }, keys = ['to', 'cc', 'bcc'];
      var listed = function(r){ return keys.filter(function(k){ return norm(r[k]).length }).map(function(k){ return names[k] + ' ' + norm(r[k]).join(', ') }).join('; ') || 'nobody' };
      var same = keys.every(function(k){ return norm(a.m[k]).join('\\n') === norm(built[k]).join('\\n') });
      if (!same) { try { o.delete(m) } catch (e) {} return JSON.stringify({ refused: 'Outlook made this ' + (a.m.replyTo ? 'reply' : 'forward') + ' for ' + listed(built) + ', not ' + listed(a.m) + ' as held, so nothing was sent.' }) }
    }
    var id = String(m.id()); if (a.send) o.send(m); return JSON.stringify(id)`),
  events: js(`var o = app('Microsoft Outlook'); var from = new Date(a.from), to = new Date(a.to);
    var es = o.calendarEvents.whose({ _and: [{ startTime: { _greaterThanEquals: from } }, { startTime: { _lessThan: to } }] });
    var ids = all(es.id()), subj = all(es.subject()), st = all(es.startTime()), en = all(es.endTime()), loc = all(es.location()), org = all(es.organizer()), out = [];
    for (var i = 0; i < Math.min(ids.length, 500); i++) out.push({ id: String(ids[i]), subject: String(subj[i]), start: st[i].toISOString(), end: en[i].toISOString(), location: String(loc[i] || ''), organizer: String(org[i] || ''),
      attendees: all(es[i].attendees()).map(function(x){ return addr(x.emailAddress()) }), response: '' });
    return JSON.stringify(out)`),
  createEvent: js(`var o = app('Microsoft Outlook'); var acc = a.e.account ? account(o, a.e.account) : null;
    var e = o.CalendarEvent({ subject: a.e.subject, startTime: new Date(a.e.start), endTime: new Date(a.e.end), location: a.e.location || '', content: a.e.body || '' });
    (acc ? acc.defaultCalendar.calendarEvents : o.calendarEvents).push(e); a.e.attendees.forEach(function(x){ e.requiredAttendees.push(o.RequiredAttendee({ emailAddress: { address: x } })) });
    if (a.e.attendees.length) { if (acc) o.sendMeeting(e, { fromAccount: acc }); else o.sendMeeting(e) } return JSON.stringify(String(e.id()))`),
  eventByUid: js(`var o = app('Microsoft Outlook'); var now = Date.now(); var from = new Date(now - 7 * 864e5), to = new Date(now + 183 * 864e5);
    var es = o.calendarEvents.whose({ _and: [{ startTime: { _greaterThanEquals: from } }, { startTime: { _lessThan: to } }] }); var ids = all(es.id()), ics = all(es.icalendarData());
    for (var i = 0; i < ids.length; i++) if (String(ics[i] || '').replace(/\\r?\\n[ \\t]/g, '').split(/\\r?\\n/).indexOf('UID:' + a.uid) >= 0) return JSON.stringify(String(ids[i]));
    return 'null'`),
  // Office as a renderer (docs/agents/work-office.md "Office as a renderer"): a copy in the app's own container,
  // opened in the app he has open, saved as by the app itself, closed unsaved. Unproven on a Mac: not offered
  // until each pair's own live proof passes (render.ts RENDER_PROVEN).
  renderWord: js(`var w = app('Microsoft Word'); w.open(Path(a.input)); var d = byKey(w.documents, a.input), pages = null;
    try { try { pages = Number(w.computeStatistics(d, { statistic: 'statistic pages' })) } catch (e) {}
      w.saveAs(d, { fileName: a.output, fileFormat: 'format PDF' }); return JSON.stringify({ pages: pages }) }
    finally { try { w.close(d, { saving: 'no' }) } catch (e) {} }`),
  renderExcel: js(`var xl = app('Microsoft Excel'); xl.open(Path(a.input)); var b = byKey(xl.workbooks, a.input);
    try { xl.saveWorkbookAs(b, { filename: a.output, fileFormat: 'PDF file format' }); return JSON.stringify({}) }
    finally { try { xl.close(b, { saving: 'no' }) } catch (e) {} }`),
  // PNG saves every slide into a folder (Slide1.png, …): the host keeps the one asked for. A video is PowerPoint's MP4.
  renderPowerPoint: js(`var pp = app('Microsoft PowerPoint'); pp.open(Path(a.input)); var p = byKey(pp.presentations, a.input), n = p.slides.length;
    try { pp.save(p, { in: Path(a.output), as: a.to === 'pdf' ? 'save as PDF' : a.to === 'png' ? 'save as PNG' : 'save as MP4' }); return JSON.stringify({ pages: n }) }
    finally { try { pp.close(p, { saving: 'no' }) } catch (e) {} }`),
  // Presenting in PowerPoint (docs/agents/work-office.md "Presenting in PowerPoint"): the deck `open` just handed the
  // app, waited for while it opens, then PowerPoint's own slideshow of every slide from the first. Unproven on a Mac:
  // not offered until its live proof passes (present.ts PRESENT_PROVEN).
  presentPowerPoint: js(`var pp = app('Microsoft PowerPoint'), p = null;
    for (var i = 0; i < 60 && !p; i++) { try { p = byKey(pp.presentations, a.key) } catch (e) { if (i === 59) throw e; if (typeof delay === 'function') delay(0.25) } }
    // The settings' writes mark the deck changed (found live, PowerPoint 16.115): a deck that was saved is marked saved again, so presenting never asks him to save.
    var was = p.saved(), s = p.slideShowSettings; try { s.rangeType = 'slide show range show all' } catch (e) {} try { s.startingSlide = 1; s.endingSlide = p.slides.length } catch (e) {}
    if (was) try { p.saved = true } catch (e) {}
    pp.runSlideShow(s); try { pp.activate() } catch (e) {} return JSON.stringify({ slides: p.slides.length })`),
  answerEvent: js(`var o = app('Microsoft Outlook'); var e = o.calendarEvents.byId(Number(a.id)); var p = { sendingResponse: true }; if (a.comment) p.comment = a.comment;
    if (a.answer === 'accept') o.acceptMeeting(e, p); else if (a.answer === 'decline') o.declineMeeting(e, p); else o.acceptTentativelyMeeting(e, p); return 'null'`)
} as const
export type ScriptName = keyof typeof SCRIPTS

/** Whether a call could drive an app, as the last call to it found. macOS will not say without asking him, so the first call finds out. */
const allowedSeen = new Map<OfficeApp, OfficeAllowed>()

/**
 * An app known to wait on him: macOS asks, once for each app, whether it may "access files managed by" OneDrive
 * the first time it opens a file under ~/Library/CloudStorage, and until he answers the app's main thread sits in
 * that call and answers no script at all (found live on his Mac, 2026-11-22: a read through Excel hung for the
 * link's 120 seconds, twice). Nothing can answer it for him. The words are kept so Connections says them.
 */
const waitingSeen = new Map<OfficeApp, string>()

/**
 * Prints the system prompt's sentence when one is up for the app named, else nothing; never throws. The prompt is a
 * window of UserNotificationCenter. ASCII only: osascript misreads the prompt's curly quotes from a script on stdin.
 */
export const ACCESS_PROMPT_SCRIPT = `on run argv
	set appName to item 1 of argv
	try
		with timeout of 2 seconds
			tell application "System Events"
				if not (exists process "UserNotificationCenter") then return ""
				set texts to value of static texts of every window of process "UserNotificationCenter"
			end tell
		end timeout
		repeat with perWindow in texts
			repeat with t in perWindow
				set s to t as text
				if s contains " wants to access files managed by " and s contains (appName & ".app") then return s
			end repeat
		end repeat
	end try
	return ""
end run`

/** What a waiting app's call answers, and what its Connections row says. */
export const waitingWords = (app: OfficeApp): string =>
  `${APP_NAMES[app]} is waiting for the owner on this Mac: macOS asks whether it may access files managed by OneDrive. He presses Allow on that prompt once; until then it answers nothing.`

const APP_OF: Record<ScriptName, OfficeApp> = {
  workbooks: 'excel',
  readRange: 'excel',
  writeRange: 'excel',
  documents: 'word',
  readDocument: 'word',
  editDocument: 'word',
  presentations: 'powerpoint',
  readSlides: 'powerpoint',
  replaceSlideText: 'powerpoint',
  accounts: 'outlook',
  listMail: 'outlook',
  readMail: 'outlook',
  mail: 'outlook',
  events: 'outlook',
  createEvent: 'outlook',
  eventByUid: 'outlook',
  answerEvent: 'outlook',
  renderWord: 'word',
  renderExcel: 'excel',
  renderPowerPoint: 'powerpoint',
  presentPowerPoint: 'powerpoint'
}

const RENDER_SCRIPT: Record<RenderApp, ScriptName> = { word: 'renderWord', excel: 'renderExcel', powerpoint: 'renderPowerPoint' }
/** Each app's sandbox: a file in its own container opens and saves with no "Grant File Access" prompt for him to answer. */
export const RENDER_CONTAINER: Record<RenderApp, string> = { word: 'com.microsoft.Word', excel: 'com.microsoft.Excel', powerpoint: 'com.microsoft.Powerpoint' }
export const renderFolder = (home: string, app: RenderApp): string => join(home, 'Library', 'Containers', RENDER_CONTAINER[app], 'Data', 'Library', 'Caches', 'TempCode')

export interface MacDeps {
  osa?: Osa
  /** whether an app's bundle is on this Mac */
  installed?: (app: OfficeApp) => boolean
  running?: (app: OfficeApp) => Promise<boolean>
  /** `open` with its arguments: the switch */
  open?: (args: string[]) => Promise<void>
  /** whether Outlook runs as New Outlook: its own setting, read without starting it */
  newOutlook?: () => Promise<boolean>
  /** how long `open` looks for the system's file-access prompt after opening a file OneDrive manages, in looks of a second; default 3 */
  promptLooks?: number
  sleep?: (ms: number) => Promise<void>
  /** the home whose app containers a render's copy goes in; default the user's */
  home?: string
  /** `sips` with its arguments: a slide's PNG brought to the width asked */
  sips?: (args: string[]) => Promise<void>
}

/**
 * New Outlook for Mac ships the legacy scripting dictionary but does not answer it: accounts,
 * folders and messages come back empty (Microsoft's answers on Q&A, 2023 to 2026: AppleScript is
 * "still not supported in the New Outlook for Mac"; Legacy Outlook still runs it).
 */
export const NEW_OUTLOOK =
  "New Outlook does not answer scripts yet, so this Mac carries no Outlook mail or invitations. To carry them, turn off New Outlook in Outlook's menu and use Legacy Outlook."

/** Outlook's own "New Outlook" switch (`IsRunningNewOutlook`), read from its defaults; false when unset or unreadable. */
const readNewOutlook = (): Promise<boolean> =>
  new Promise((resolve) => execFile('/usr/bin/defaults', ['read', 'com.microsoft.Outlook', 'IsRunningNewOutlook'], (err, out) => resolve(!err && String(out).trim() === '1')))

const appPath = (app: OfficeApp): string => `/Applications/${APP_NAMES[app]}.app`

// By the bundle's executable path, not `-x <name>`: macOS cuts a process's name to 16 characters, so "Microsoft PowerPoint" and "Microsoft Outlook" never matched.
const pgrep = (app: OfficeApp): Promise<boolean> => new Promise((resolve) => execFile('/usr/bin/pgrep', ['-f', `${appPath(app)}/Contents/MacOS/`], (err) => resolve(!err)))

const runSips = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => execFile('/usr/bin/sips', args, (err) => (err ? reject(new OfficeError(`The slide's picture could not be sized: ${err.message}`)) : resolve())))

/** What `open` said when it failed, in the carrier's words: a file that is not there is `not-found`, said plainly (as the Windows helper says it). */
export const openFailure = (message: string): OfficeError =>
  /does not exist/i.test(message) ? new OfficeError('There is no such file on this Mac.', 'not-found') : new OfficeError(`The file did not open: ${message.trim()}`)

const openWith = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => execFile('/usr/bin/open', args, (err) => (err ? reject(openFailure(err.message)) : resolve())))

export function macCarrier(deps: MacDeps = {}): OfficeCarrier {
  const osa = deps.osa ?? runOsa
  const installed = deps.installed ?? ((app: OfficeApp) => existsSync(appPath(app)))
  const running = deps.running ?? pgrep
  /** Whether the system's file-access prompt is up for the app now; remembered while it is, forgotten once it has gone. */
  const prompted = async (app: OfficeApp): Promise<boolean> => {
    const said = await osa('AppleScript', ACCESS_PROMPT_SCRIPT, [APP_NAMES[app]]).catch(() => '')
    if (said.trim()) waitingSeen.set(app, waitingWords(app))
    else waitingSeen.delete(app)
    return !!said.trim()
  }
  const call = async <T>(name: ScriptName, args: unknown): Promise<T> => {
    const app = APP_OF[name]
    if (!installed(app)) throw new OfficeError(`${APP_NAMES[app]} is not installed on this Mac.`, 'not-installed')
    try {
      const out = await osa('JavaScript', SCRIPTS[name], [JSON.stringify(args)])
      allowedSeen.set(app, 'yes')
      waitingSeen.delete(app)
      return JSON.parse(out || 'null') as T
    } catch (err) {
      if (err instanceof OsaTimeout) {
        // Nothing came back at all: the system's prompt holds the app, or a dialog of its own does.
        if (await prompted(app)) throw new OfficeError(waitingWords(app), 'needs-consent')
        throw new OfficeError(`${APP_NAMES[app]} did not answer within ${Math.round(OSA_TIMEOUT_MS / 1000)} s: a dialog may be open in it on this Mac.`, 'busy')
      }
      // A refusal the script threw names no app: name the one it was for.
      if (err instanceof OfficeError && err.message.includes('the Office app')) err = new OfficeError(err.message.replace('the Office app', APP_NAMES[app]), err.code)
      // The app answered "no such item": it let us in.
      if (err instanceof OfficeError && err.code === 'not-found') allowedSeen.set(app, 'yes')
      if (err instanceof OfficeError && err.code === 'not-allowed') allowedSeen.set(app, 'no')
      if (err instanceof OfficeError && err.code === 'needs-consent') allowedSeen.set(app, 'ask')
      throw err
    }
  }
  // A reply or forward whose recipients Outlook built otherwise than held comes back refused, thrown away unsent.
  const mail = async (m: unknown, send: boolean): Promise<string> => {
    const made = await call<string | { refused: string }>('mail', { m, send })
    if (typeof made === 'object' && made && 'refused' in made) throw new OfficeError(made.refused, 'refused')
    return made
  }
  /**
   * Office as a renderer on this Mac: only in an app he already has open (never started unseen), on a copy in that
   * app's container, which goes after. Not offered until proven (render.ts RENDER_PROVEN.mac).
   */
  const render = async (ask: RenderAsk): Promise<RenderDone> => {
    if (!installed(ask.app)) throw new OfficeError(`No ${APP_NAMES[ask.app]} is in reach: it is not installed on this Mac.`, 'not-installed')
    if (!(await running(ask.app))) throw new OfficeError(`${APP_NAMES[ask.app].replace('Microsoft ', '')} is not open on this Mac.`, 'not-running')
    if (isPasswordLocked(ask.input)) throw new OfficeError(lockedWords(ask.app), 'refused')
    const dir = join(renderFolder(deps.home ?? homedir(), ask.app), randomBytes(8).toString('hex'))
    mkdirSync(dir, { recursive: true })
    try {
      const input = join(dir, `input${extname(ask.input).toLowerCase()}`)
      copyFileSync(ask.input, input)
      const output = ask.to === 'png' ? join(dir, 'slides') : join(dir, `output.${ask.to}`)
      const done = await call<{ pages?: number | null }>(RENDER_SCRIPT[ask.app], { input, output, to: ask.to })
      if (ask.to === 'png') {
        const want = ask.slide ?? 1
        const made = existsSync(output) ? readdirSync(output).filter((f) => /\.png$/i.test(f)) : []
        const slide = made.find((f) => Number(/(\d+)\.png$/i.exec(f)?.[1]) === want)
        if (!slide) throw new OfficeError(made.length ? `The deck has ${made.length} slides; there is no slide ${want}.` : 'PowerPoint made no picture of the slides.', made.length ? 'not-found' : 'failed')
        await (deps.sips ?? runSips)(['--resampleWidth', String(ask.width ?? 1920), join(output, slide), '--out', ask.output])
        return { width: ask.width ?? 1920 }
      }
      if (!existsSync(output)) throw new OfficeError(`${APP_NAMES[ask.app]} made no ${ask.to.toUpperCase()}.`)
      copyFileSync(output, ask.output)
      return typeof done?.pages === 'number' ? { pages: done.pages } : {}
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const open: OfficeCarrier['open'] = async (app, ref) => {
    if (!installed(app)) throw new OfficeError(`${APP_NAMES[app]} is not installed on this Mac.`, 'not-installed')
    await (deps.open ?? openWith)(ref.kind === 'path' ? ['-a', APP_NAMES[app], ref.path] : [`ms-${app}:ofe|u|${ref.url}`])
    // A file OneDrive manages: the first one an app opens raises the system's prompt within a few seconds, and the
    // open is then no open at all. Said now, in words, not found out by the next call's two-minute silence.
    if (ref.kind === 'path' && ref.path.includes('/Library/CloudStorage/') && app !== 'outlook') {
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
      for (let i = 0; i < (deps.promptLooks ?? 3); i++) {
        await sleep(1000)
        if (await prompted(app)) throw new OfficeError(waitingWords(app), 'needs-consent')
      }
    }
  }
  return {
    kind: 'mac',
    render,
    async outlookProblem() {
      return installed('outlook') && (await (deps.newOutlook ?? readNewOutlook)()) ? NEW_OUTLOOK : null
    },
    async apps() {
      return Promise.all(
        OFFICE_APPS.map(async (app) => {
          const has = installed(app)
          // an app last seen waiting is looked at again: he may have answered since
          const waiting = has && waitingSeen.has(app) && (await prompted(app)) ? waitingSeen.get(app) : undefined
          return { app, installed: has, running: has && (await running(app)), allowed: allowedSeen.get(app) ?? 'unknown', ...(waiting ? { waiting } : {}) }
        })
      )
    },
    workbooks: () => call('workbooks', {}),
    readRange: (book, sheet, address) => call('readRange', { book, sheet, address }),
    writeRange: (book, sheet, address, grid: OfficeCell[][]) =>
      call('writeRange', { book, sheet, address, grid, formulas: grid.some((row) => row.some((c) => typeof c === 'string' && c.startsWith('='))) }),
    documents: () => call('documents', {}),
    readDocument: (doc) => call('readDocument', { doc }),
    editDocument: (doc, edit, tracked) => call('editDocument', { doc, edit, tracked }),
    presentations: () => call('presentations', {}),
    readSlides: (pres) => call('readSlides', { pres }),
    replaceSlideText: (pres, find, replace) => call('replaceSlideText', { pres, find, replace }),
    accounts: () => call('accounts', {}),
    listMail: (q) => call('listMail', q),
    readMail: (id) => call('readMail', { id }),
    draftMail: (m) => mail(m, false),
    sendMail: async (m) => ({ id: await mail(m, true) }),
    events: (from, to) => call('events', { from, to }),
    // An invitation's body is plain text on every carrier (Outlook on the web sends it as Text, Windows sets Body): the
    // Mac's `content` reads HTML, so the text goes escaped, each line kept, and what he read in the Outbox is what goes.
    createEvent: (e) => call('createEvent', { e: e.body === undefined ? e : { ...e, body: textAsHtml(e.body) } }),
    answerEvent: (id, answer, comment) => call('answerEvent', { id, answer, comment }),
    eventByUid: (uid) => call('eventByUid', { uid }),
    // His press alone: the deck opened in PowerPoint (which starts it if it was shut), then its own slideshow.
    async present(ref) {
      await open('powerpoint', ref)
      await call('presentPowerPoint', { key: ref.kind === 'path' ? ref.path : ref.url })
    },
    open
  }
}
