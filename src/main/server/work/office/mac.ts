import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { OFFICE_APPS, type OfficeAllowed, type OfficeApp, type OfficeCell } from '@shared/contract-work-office'
import { APP_NAMES, OfficeError, type OfficeCarrier } from './carrier'
import { runOsa, type Osa } from './osa'

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
function byKey(list, key){ list = all(list); for (var i = 0; i < list.length; i++) if (list[i].fullName() === key || list[i].name() === key) return list[i]; throw new Error('Nothing open named ' + key + '. (-1728)') }
function files(list){ return all(list).map(function(f){ return { key: f.fullName(), name: f.name() } }) }
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
  readRange: js(`var r = book(app('Microsoft Excel'), a.book).worksheets.byName(a.sheet).ranges.byName(a.address);
    var v = grid(r.value()), f = grid(r.formula2()), z = grid(r.numberFormat());
    return JSON.stringify({ values: v.map(function(row){ return row.map(cell) }),
      formulas: f.map(function(row){ return row.map(function(x){ return typeof x === 'string' && x.charAt(0) === '=' ? x : '' }) }),
      formats: z.map(function(row){ return row.map(function(x){ return x == null ? '' : String(x) }) }) })`),
  writeRange: js(`var r = book(app('Microsoft Excel'), a.book).worksheets.byName(a.sheet).ranges.byName(a.address);
    var g = a.grid.map(function(row){ return row.map(out) });
    var one = g.length === 1 && g[0].length === 1;
    if (a.formulas) r.formula2 = one ? String(g[0][0]) : g.map(function(row){ return row.map(String) }); else r.value = one ? g[0][0] : g;
    return 'null'`),
  documents: js(`return JSON.stringify(files(app('Microsoft Word').documents()))`),
  readDocument: js(`var d = byKey(app('Microsoft Word').documents(), a.doc); return JSON.stringify(String(d.textObject.content()).split('\\r'))`),
  editDocument: js(`var w = app('Microsoft Word'); var d = byKey(w.documents(), a.doc); var was = d.trackRevisions(); d.trackRevisions = a.tracked; var n = 0;
    try {
      if (a.edit.insert !== undefined) { if (a.edit.at === 'start') w.insertBefore(d.textObject, { text: a.edit.insert }); else w.insertAfter(d.textObject, { text: a.edit.insert }); n = 1 }
      else { n = String(d.textObject.content()).split(a.edit.find).length - 1; if (n) w.executeFind(d.textObject.findObject, { findText: a.edit.find, replaceWith: a.edit.replace, replace: 'replace all', matchCase: true }) }
    } finally { d.trackRevisions = was }
    return JSON.stringify(n)`),
  presentations: js(`return JSON.stringify(files(app('Microsoft PowerPoint').presentations()))`),
  readSlides: js(`var p = byKey(app('Microsoft PowerPoint').presentations(), a.pres);
    return JSON.stringify(all(p.slides()).map(function(s, i){ return { index: i + 1, texts: all(s.shapes()).filter(function(h){ return h.hasTextFrame() }).map(function(h){ return String(h.textFrame.textRange.content()) }) } }))`),
  replaceSlideText: js(`var p = byKey(app('Microsoft PowerPoint').presentations(), a.pres); var n = 0;
    all(p.slides()).forEach(function(s){ all(s.shapes()).forEach(function(h){ if (!h.hasTextFrame()) return; var t = h.textFrame.textRange; var c = String(t.content());
      if (c.indexOf(a.find) >= 0) { t.content = c.split(a.find).join(a.replace); n++ } }) });
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
  answerEvent: js(`var o = app('Microsoft Outlook'); var e = o.calendarEvents.byId(Number(a.id)); var p = { sendingResponse: true }; if (a.comment) p.comment = a.comment;
    if (a.answer === 'accept') o.acceptMeeting(e, p); else if (a.answer === 'decline') o.declineMeeting(e, p); else o.acceptTentativelyMeeting(e, p); return 'null'`)
} as const
export type ScriptName = keyof typeof SCRIPTS

/** Whether a call could drive an app, as the last call to it found. macOS will not say without asking him, so the first call finds out. */
const allowedSeen = new Map<OfficeApp, OfficeAllowed>()

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
  answerEvent: 'outlook'
}

export interface MacDeps {
  osa?: Osa
  /** whether an app's bundle is on this Mac */
  installed?: (app: OfficeApp) => boolean
  running?: (app: OfficeApp) => Promise<boolean>
  /** `open` with its arguments: the switch */
  open?: (args: string[]) => Promise<void>
  /** whether Outlook runs as New Outlook: its own setting, read without starting it */
  newOutlook?: () => Promise<boolean>
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

const openWith = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => execFile('/usr/bin/open', args, (err) => (err ? reject(new OfficeError(`The file did not open: ${err.message}`)) : resolve())))

export function macCarrier(deps: MacDeps = {}): OfficeCarrier {
  const osa = deps.osa ?? runOsa
  const installed = deps.installed ?? ((app: OfficeApp) => existsSync(appPath(app)))
  const running = deps.running ?? pgrep
  const call = async <T>(name: ScriptName, args: unknown): Promise<T> => {
    const app = APP_OF[name]
    if (!installed(app)) throw new OfficeError(`${APP_NAMES[app]} is not installed on this Mac.`, 'not-installed')
    try {
      const out = await osa('JavaScript', SCRIPTS[name], [JSON.stringify(args)])
      allowedSeen.set(app, 'yes')
      return JSON.parse(out || 'null') as T
    } catch (err) {
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
  return {
    kind: 'mac',
    async outlookProblem() {
      return installed('outlook') && (await (deps.newOutlook ?? readNewOutlook)()) ? NEW_OUTLOOK : null
    },
    async apps() {
      return Promise.all(
        OFFICE_APPS.map(async (app) => {
          const has = installed(app)
          return { app, installed: has, running: has && (await running(app)), allowed: allowedSeen.get(app) ?? 'unknown' }
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
    async open(app, ref) {
      if (!installed(app)) throw new OfficeError(`${APP_NAMES[app]} is not installed on this Mac.`, 'not-installed')
      await (deps.open ?? openWith)(ref.kind === 'path' ? ['-a', APP_NAMES[app], ref.path] : [`ms-${app}:ofe|u|${ref.url}`])
    }
  }
}
