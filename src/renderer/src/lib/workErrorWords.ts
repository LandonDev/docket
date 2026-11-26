import { refusalWords } from "./settingsHome";

/**
 * An error as Work says it to him (docs/agents/work.md "Errors on screen"). A host answers a refusal in its own
 * words, and some of those were never written for a person: a method's name, a path on the host's disk, an errno,
 * a wait in seconds, a schema's complaint. Each known raw form has its sentence here; a refusal that is already
 * plain passes as `refusalWords` gives it; anything else that still carries a path, a method, an id or a code
 * answers "", so the caller's own line for that act shows ("Budget.xlsx did not open") in place of the raw text.
 *
 * `write` marks an act that changes something: when its answer was lost the words say it is uncertain, never
 * that it failed, since the change may have gone through.
 */
export interface ErrorContext {
  /** the computer asked, by the name the rail gives it ("the box", "This Mac") */
  host?: string;
  write?: boolean;
}

type Rule = [RegExp, (c: { host: string; Host: string; named: boolean; write: boolean }, m: RegExpExecArray) => string];

const lost = (c: { Host: string; write: boolean }): string =>
  c.write ? `${c.Host} did not confirm the change. Check whether it went through before you try again.` : `${c.Host} did not answer. Try again once it is connected.`;

/** The Office app a format belongs to: a pair's target names it when Office draws ("pdf+word"), else its source. */
const OFFICE: Record<string, string> = { docx: "Word", doc: "Word", word: "Word", xlsx: "Excel", xls: "Excel", xlsm: "Excel", excel: "Excel", pptx: "PowerPoint", ppt: "PowerPoint", powerpoint: "PowerPoint" };
const appOf = (from: string, to: string): string | undefined => OFFICE[to.toLowerCase().split("+")[1] ?? ""] ?? OFFICE[from.toLowerCase()];
/** A source format as the files it is ("Word files", "PDFs"); one Work has no plain name for is "this file". */
const filesOf = (format: string): string => (OFFICE[format.toLowerCase()] ? `${OFFICE[format.toLowerCase()]} files` : format.toLowerCase() === "pdf" ? "PDFs" : "this file");

/** Why a sheet's host could not read a workbook, by the cause it named, with what Excel can do about it. */
function importRefusal(c: { host: string; Host: string }, cause: string): string {
  if (/password/i.test(cause)) return `${c.Host} cannot read a workbook locked with a password. Remove the password in Excel to edit it here.`;
  if (/\.xlsb|binary workbook/i.test(cause)) return `${c.Host} cannot read a binary workbook (.xlsb). Save it as .xlsx in Excel to edit it here.`;
  if (/strict open xml/i.test(cause)) return `${c.Host} cannot read Strict Open XML. Save it in Excel as an Excel Workbook (.xlsx) to edit it here.`;
  if (/too big/i.test(cause)) return `This workbook is too big for ${c.host} to read. Edit it in Excel.`;
  return `${c.Host} could not read this workbook. It may be damaged: open it in Excel and save it again.`;
}

/** The host's sentence for a recording it cannot transcribe: the meeting tools are not installed (pipeline.ts `missingSentence`). */
const TRANSCRIBER_MISSING = /not installed on this host; run scripts\/work-tools\/install\b|\b(sherpa-onnx|parakeet[\w.-]*|pyannote[\w.-]*|wespeaker[\w.-]*|silero[\w.-]*)\b[^.]*\bnot installed\b/i;

/** Whether a host's error is the transcriber not set up there, so the line can offer the way to set it up (`TranscriberSetUp`). */
export const transcriberMissing = (error: unknown): boolean => TRANSCRIBER_MISSING.test(refusalWords(error));

const RULES: Rule[] = [
  // The fence and the capability door (remote/fence.ts, shared/capabilities.ts).
  [/^forbidden: \S+ is outside app-managed roots/i, (c) => `${c.Host} does not let this window reach that file where it lies. Open it from Files on the computer that holds it.`],
  [/^forbidden: \S+ is local-only/i, (c) => `This is done in a window on ${c.host} itself.`],
  [/^forbidden: \S+ (needs \w+|is not for a given computer|waits for Allow)/i, (c) => `This computer's key may not do that on ${c.host}. Do it from a computer that manages ${c.host}.`],
  // A request the host's contract did not read: a schema's own complaint, never his fault.
  [/^bad request\b|^\[\s*\{\s*"(code|expected|origin|path)"/i, (c) => `${c.Host} could not read this request. Open this view again and retry; if it still fails, update the app on both computers.`],
  // Unnamed, the host's own line stands: it is plain already, and "that computer" would say less.
  [/work is off on this host/i, (c, m) => (c.named ? `Work is off on ${c.host}. Turn it on in Settings, Work.` : m.input)],
  // An answer that never came (files/store.ts, connection/transport.ts).
  [/^no answer in \d+ ?s\b|timed out after \d|\btimed out\b|^timeout\b/i, lost],
  // A caller's own stand-in for an answer that never came (work/sheets/sync.ts): told the computer, it says which.
  [/^the host did not answer\.?$/i, (c, m) => (c.named ? lost(c) : m.input)],
  // The link's own bare word: with a computer named it says which is away; unnamed it stands as it is.
  [/^not connected\.?$/i, (c, m) => (c.named ? `${c.Host} is not connected. Try again once it is back.` : m.input)],
  // A link closed for good rejects with its bare word (connection/transport.ts).
  [/connection closed|socket closed|^closed\.?$/i, (c) => `The connection to ${c.host} dropped.${c.write ? " Check whether the change went through." : " Try again once it is back."}`],
  // Work's own parts that did not load (work/ctx.ts, shared/work/ids.ts).
  [/did not start on this host|^not built\b|is not built yet|no handler for/i, (c) => `This part of Work is not running on ${c.host}. Look under Settings, Connections; if the two computers run different versions, update both.`],
  [/^(unknown|no such) workspace\b/i, (c) => `This workspace is no longer on ${c.host}.`],
  [/^(there is )?no canvas item\b/i, () => "This tab is no longer open. Open the file again from Files."],
  [/^not a work workspace\b|^unknown thread\b/i, () => "The thread or workspace this belongs to is gone. Open it again from Work."],
  // The disk, by errno: the file's own words, never the path.
  // A line that starts with it reaches here capitalized (`refusalWords`): "Spawn osascript ENOENT".
  [/\bspawn \S+ ENOENT\b/i, (c) => `A program ${c.host} needs for this is missing there.`],
  [/\bENOENT\b|^there is no file at |^no file at /i, () => "The file or folder was moved or removed. Refresh Files and open it from where it is now."],
  [/\b(EACCES|EPERM|EROFS)\b/, () => "This computer could not change the file in that folder. Check that you may edit it there, or save a copy somewhere you may."],
  [/\bENOSPC\b/, (c) => `The disk on ${c.host} is full.`],
  [/\b(EBUSY|ETXTBSY)\b/, () => "The file is in use. Close it where it is open and try again."],
  [/\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)\b/, lost],
  // Conversions and previews (work/formats).
  [/left no output$/i, () => "The conversion made no file. Open the original and export again."],
  // The converter's four refusals (main/server/work/formats/jobs.ts `convert`, `forward`): the pair is a format's id
  // ("docx to pdf+word"), said as the files it draws; the host's id and "his own press" never reach him.
  [/^no converter from (\S+) to/i, (c, m) => `${c.Host} has no app that draws ${filesOf(m[1]!)}.`],
  [/^(?!.*not installed).*never carried to another host/i, (c) => `A shared file is drawn only on the computer that holds it, and ${c.host} cannot draw it now.`],
  [/converts (\S+) to (\S+) is asleep on /i, () => "The Windows VM that draws it is asleep. Wake it from a window on the computer that runs it."],
  [/converts (\S+) to (\S+) is asleep\b/i, (_c, m) => `The Windows VM is asleep.${appOf(m[1]!, m[2]!) ? ` Check in ${appOf(m[1]!, m[2]!)} wakes it.` : ""}`],
  [/the app that converts (\S+) to (\S+) is not open\b/i, (c, m) => `${appOf(m[1]!, m[2]!) ?? "The app that draws it"} is not open on ${c.host}.`],
  [/cannot convert (\S+) to \S+ now(, and no linked host)?/i, (c, m) => `${c.Host} cannot draw ${filesOf(m[1]!)} now${m[2] ? ", and no computer linked to it can" : ""}.`],
  [/^(.+) is (\d+ MB); a job carried to another host takes at most (\d+ MB)/i, (_c, m) => `${m[1]} is ${m[2]}, more than the ${m[3]} another computer is sent to draw.`],
  [/came back is (\d+ MB); a job carried from another host takes at most (\d+ MB)|^a forwarded job takes at most (\d+ MB)/i, () => "What came back from the computer that drew it was too big to bring here."],
  // pdf.js on bytes it cannot read (pdf/engine.ts): a file cut short or damaged, never the parser's own words.
  [/^(invalid pdf structure|missing pdf\b|unexpected server response)/i, () => "This PDF is damaged, or only part of it arrived. Open it again from Files."],
  [/not a name a preview is kept under|that item is not open|that preview is gone/i, () => "This preview is gone. Close it and open it again from the file's tab."],
  // A workbook the sheet's importer refused (main/server/work/sheets/jobs.ts `refusalOf`): the cause and what Excel can do.
  [/^this file cannot be opened here: (.*)$/i, (c, m) => importRefusal(c, m[1]!)],
  // LifeOS, guests, the Windows VM.
  // Signed out is said only where the host said so. "Not connected" is the host's word for any state but connected
  // (signed out, a sign-in waiting, LifeOS not answering), so it reads as that: the cause and its fix are on Connections.
  [/lifeos is not signed in|lifeos is signed out/i, (c) => `Not signed in to LifeOS on ${c.host}. Sign in under Settings, Connections.`],
  [/lifeos did not start|lifeos is not connected/i, (c) => `${c.Host} cannot use LifeOS now. See why under Settings, Connections.`],
  // The meetings transcriber's own tools missing (main/server/work/meetings/pipeline.ts `missingSentence`): one fact, the
  // computer named, never the programs or the script that installs them. Before the drawing tools' rule, which names ffmpeg too.
  [TRANSCRIBER_MISSING, (c) => `The transcriber is not set up on ${c.host}.`],
  // A tool a host draws or reads files with, named by its program: what he can do, never the program's name.
  [/\b(libreoffice|soffice|python-pptx|ffmpeg|ffprobe|pymupdf\w*)\b[^.]*\bnot installed\b/i, (c) => `${c.named ? `${c.Host} is missing the tools that draw and read this file.` : "The computer that draws this file is missing the tools for it."} Install them under Settings, Connections, Conversion tools.`],
  [/^no such guest link\b/i, (c) => `This link is not on ${c.host}. Look for it on the computer that made it.`],
  [/its bytes go to no caller/i, () => "Open this file from its library in Files. The copy is made on the computer that runs the Windows VM."],
];

/** What marks a line as never written for him: a wire method (capitalized when it starts the line), a path, a host's id, an errno, a schema's JSON, a stack. */
const RAW = /\b[Ww]ork\.[a-z][A-Za-z.]*|\b(session|workspace|remote|defaults)\.[a-z][A-Za-z]+\b|(^|[\s'"(])\/[\w.@-]+\/[\w.@/ -]+|[A-Za-z]:\\[\w\\. -]+|\benv_[\w-]{6,}|\bE[A-Z]{3,}\b(?=[:,]| )|^\s*[[{]|\n\s+at \S+ \(|^forbidden:/;

export function workErrorWords(error: unknown, context: ErrorContext = {}): string {
  const words = refusalWords(error);
  if (!words) return "";
  const host = context.host?.trim() || "that computer";
  const c = { host, Host: host.charAt(0).toUpperCase() + host.slice(1), named: !!context.host?.trim(), write: context.write === true };
  for (const [form, say] of RULES) {
    const m = form.exec(words);
    if (m) return say(c, m);
  }
  return RAW.test(words) ? "" : words;
}
