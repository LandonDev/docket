import { NotInReach, PAPERS, type PreviewBytes, type PreviewPicture, type PreviewSource } from "./preview";

/**
 * The rules a `PreviewSource` keeps (preview.ts), as one function a build
 * runs on its own source in its own tests:
 *
 *   expect(await previewProblems(source)).toEqual([])
 *
 * It draws every format once, reads each render twice at its `rev`, asks for
 * Office's picture where the source offers it, and checks the page set-up.
 * It never exports unless asked (`exports: true`): an export writes a file.
 */

export interface ContractOptions {
  /** also call `export` on every format, and check the name it answers */
  exports?: boolean;
  /** only these formats (a source whose renders are slow) */
  only?: string[];
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

async function bytesProblems(what: string, bytes: PreviewBytes, magic?: number[]): Promise<string[]> {
  const out: string[] = [];
  if (!bytes.rev) out.push(`${what}: the render has no rev`);
  if (!(bytes.size > 0)) out.push(`${what}: the render is empty`);
  if (out.length) return out;
  const head = await bytes.read(0, Math.min(64, bytes.size));
  if (head.length !== Math.min(64, bytes.size)) out.push(`${what}: a read of ${Math.min(64, bytes.size)} bytes answered ${head.length}`);
  if (magic && magic.some((b, i) => head[i] !== b)) out.push(`${what}: the bytes are not the file they claim to be`);
  const again = await bytes.read(0, Math.min(64, bytes.size));
  if (again.length !== head.length || again.some((b, i) => b !== head[i])) out.push(`${what}: two reads at one rev differ`);
  if (bytes.size > 1) {
    const tail = await bytes.read(bytes.size - 1, 1);
    if (tail.length !== 1) out.push(`${what}: the last byte could not be read`);
  }
  return out;
}

async function pictureProblems(what: string, picture: PreviewPicture, paged: boolean): Promise<string[]> {
  const out: string[] = [];
  if (paged !== (picture.kind === "paged")) out.push(`${what}: the format says ${paged ? "paged" : "not paged"} and drew ${picture.kind}`);
  if (picture.kind === "paged") {
    if (!Number.isInteger(picture.pages) || picture.pages < 1) out.push(`${what}: ${picture.pages} pages`);
    const shown = picture.shown;
    if (shown && !(shown.from >= 1 && shown.to >= shown.from && shown.of >= shown.to)) out.push(`${what}: the pages shown are not a range of the whole`);
    else if (shown && shown.to - shown.from + 1 !== picture.pages) out.push(`${what}: pages ${shown.from} to ${shown.to} are shown and the PDF holds ${picture.pages}`);
    out.push(...(await bytesProblems(what, picture.pdf, PDF_MAGIC)));
  } else if (picture.kind === "video") {
    if (!(picture.seconds > 0)) out.push(`${what}: a video of no length`);
    out.push(...(await bytesProblems(what, picture.video)));
  } else if (picture.kind === "files") {
    if (picture.files.some((f) => !f.name)) out.push(`${what}: a file with no name`);
  } else if (picture.kind === "table") {
    if (!picture.name) out.push(`${what}: a table with no name`);
  }
  return out;
}

/** Every way `source` breaks the contract, in words; empty when it keeps it. */
export async function previewProblems(source: PreviewSource, opts: ContractOptions = {}): Promise<string[]> {
  const out: string[] = [];
  const { formats } = source;
  if (!formats.length) out.push("no formats");
  const ids = new Set<string>();
  for (const f of formats) {
    if (!f.id) out.push("a format with no id");
    if (ids.has(f.id)) out.push(`${f.id}: listed twice`);
    ids.add(f.id);
    if (!f.label.trim()) out.push(`${f.id}: no label`);
    if (!f.verb.trim()) out.push(`${f.id}: no verb`);
    if (f.ext !== undefined && !/^[a-z0-9]{1,8}$/.test(f.ext)) out.push(`${f.id}: the extension "${f.ext}" is not a bare lower-case one`);
  }

  for (const f of formats) {
    if (opts.only && !opts.only.includes(f.id)) continue;
    try {
      const drawn = await source.draw(f.id, { signal: new AbortController().signal });
      out.push(...(await pictureProblems(f.id, drawn.picture, f.paged)));
      for (const line of drawn.drops) {
        if (!line.trim() || /\n/.test(line)) out.push(`${f.id}: a loss is one plain line, got ${JSON.stringify(line)}`);
        if (/not supported|unsupported/i.test(line)) out.push(`${f.id}: a loss says what happens to the thing, never "not supported"`);
      }
    } catch (err) {
      out.push(`${f.id}: could not be drawn: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A draw whose signal is already aborted must not answer a picture.
    const gone = new AbortController();
    gone.abort();
    const late = await Promise.resolve()
      .then(() => source.draw(f.id, { signal: gone.signal }))
      .then(
        () => true,
        () => false,
      );
    if (late) out.push(`${f.id}: a cancelled draw answered a picture`);
    if (opts.exports) {
      try {
        const { name } = await source.export(f.id);
        if (!name) out.push(`${f.id}: the export answered no name`);
        else if (f.ext && !name.toLowerCase().endsWith(`.${f.ext}`)) out.push(`${f.id}: the export is named ${name}, not .${f.ext}`);
      } catch (err) {
        out.push(`${f.id}: could not be exported: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (source.office) {
    const first = formats.find((f) => f.paged && (!opts.only || opts.only.includes(f.id)));
    const office = first ? await source.office(first.id) : null;
    if (first && office) {
      const { app, state } = office;
      const asked = await source.draw(first.id, { by: "office", signal: new AbortController().signal }).then(
        (drawn) => ({ drawn }),
        (err: unknown) => ({ err }),
      );
      if ("err" in asked) {
        if (!(asked.err instanceof NotInReach)) out.push(`${first.id}: Office's draw failed with something other than NotInReach`);
        else if (asked.err.app !== app) out.push(`${first.id}: NotInReach names ${asked.err.app}, office() names ${app}`);
        // Ready draws; asleep is woken by this very press and then draws.
        else if (state === "ready" || state === "asleep") out.push(`${first.id}: office() said ${state} and the draw said ${asked.err.why}`);
      } else {
        const p = asked.drawn.picture;
        // A picture from an app that was shut means it was started unseen; from none, that office() lied.
        if (state === "none" || state === "not open") out.push(`${first.id}: office() said ${state} and the draw answered a picture`);
        if (p.kind !== "paged" || p.drawnBy !== app.toLowerCase()) out.push(`${first.id}: Office's picture must say ${app} drew it`);
      }
    }
  }

  const setup = source.setup;
  if (setup) {
    const c = setup.common;
    if (!(PAPERS as readonly string[]).includes(c.paper)) out.push(`set-up: ${c.paper} is no paper`);
    if (c.orientation !== "portrait" && c.orientation !== "landscape") out.push("set-up: no orientation");
    if ([c.margins.top, c.margins.right, c.margins.bottom, c.margins.left].some((m) => !(m >= 0))) out.push("set-up: a margin under zero");
    if (typeof setup.set !== "function") out.push("set-up: no set");
  }
  return out;
}
