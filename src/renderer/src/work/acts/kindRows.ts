/**
 * The kinds that keep the generic view, read in his words beside the generic
 * reader (outbox/model.ts `payloadView`): a form's publish, a Google share, a
 * Frame.io comment or version, a Teams post, a computer act, an agent's change
 * to a shared file (`office.edit`, `google.edit`). Each says what goes and nothing
 * the host keeps for itself: no ids, revisions, paths or raw JSON. A kind not
 * named here falls back to `payloadView`.
 */

export type KindRows = { fields: { label: string; value: string }[]; body: string | null };

type Rec = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const row = (label: string, value: string | null) => (value === null ? [] : [{ label, value }]);

const ACCESS: Record<string, string> = { reader: "Can view", commenter: "Can comment", writer: "Can edit" };
const MB = 1024 * 1024;
/** "700 MB", "1.5 MB": whole above 100 MB, one place below. */
export const megabytes = (bytes: number): string => `${(bytes / MB).toFixed(bytes >= 100 * MB ? 0 : 1)} MB`;

const SHAPE: Record<string, [string, string]> = { rect: ["a box", "boxes"], ellipse: ["an oval", "ovals"], line: ["a line", "lines"], arrow: ["an arrow", "arrows"], pen: ["a drawn line", "drawn lines"] };
/** What Frame.io cannot draw as drawn, said as the host's post makes it (frameio/map.ts `annotationOf`). */
const LOSSY: Record<string, string> = { ellipse: "an oval as its box", pen: "a drawn line as straight lines" };

/** A comment's marks in words ("a pin, 2 boxes and an oval"), and what Frame.io draws otherwise ("an oval as its box"). */
export function marksWords(pin: unknown, shapes: unknown): { words: string | null; changes: string | null } {
  const counts = new Map<string, number>();
  for (const s of Array.isArray(shapes) ? shapes : []) {
    const tool = (s as { tool?: unknown } | null)?.tool;
    if (typeof tool === "string") counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  const parts = [...(pin && typeof pin === "object" ? ["a pin"] : []), ...[...counts].map(([tool, n]) => (n === 1 ? (SHAPE[tool]?.[0] ?? `a ${tool}`) : `${n} ${SHAPE[tool]?.[1] ?? `${tool}s`}`))];
  const words = parts.length ? (parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`) : null;
  const lossy = [...counts.keys()].flatMap((tool) => (LOSSY[tool] ? [LOSSY[tool]] : []));
  const cap = (t: string | null) => (t ? t[0]!.toUpperCase() + t.slice(1) : null);
  return { words: cap(words), changes: cap(lossy.join("; ") || null) };
}

// ── a computer act's steps ───────────────────────────────────────────────

type Target = { step?: unknown; param?: unknown; sig?: unknown };

/**
 * An element as the host bound it: its own role and name, `button "Send"`. The host writes the chain as JSON tuples
 * (`[["button","Send"],["group","Compose"]]`); an act held before that has the older `button:Send < group:Compose`.
 */
const sigWords = (sig: unknown): string | null => {
  if (typeof sig !== "string" || !sig) return null;
  let role: string;
  let name: string;
  if (sig.startsWith("[")) {
    let own: unknown;
    try {
      own = (JSON.parse(sig) as unknown[])[0];
    } catch {
      return null;
    }
    if (!Array.isArray(own) || typeof own[0] !== "string") return null;
    role = own[0];
    name = typeof own[1] === "string" ? own[1] : "";
  } else {
    const own = sig.split(" < ")[0]!;
    const at = own.indexOf(":");
    role = at >= 0 ? own.slice(0, at) : own;
    name = at >= 0 ? own.slice(at + 1) : "";
  }
  return name ? `${role} ${JSON.stringify(name)}` : role;
};

/**
 * A string as it goes, in quotes: JSON's escapes for quotes, backslashes and the C0 controls, and an escape for
 * every other character that cannot be seen or looks like a space: any format character (soft hyphen, zero-width
 * and invisible operators, bidi marks), control, line or paragraph separator, and any space but U+0020. Written as
 * `\uXXXX`, or `\u{XXXXX}` past the first plane, so " " and "\u00a0" never read alike.
 */
export const exactQuote = (v: string): string =>
  JSON.stringify(v).replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Zs}]/gu, (c) => {
    if (c === " ") return c;
    const code = c.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });

const CLICK: Record<string, string> = { left_click: "Clicks", right_click: "Right-clicks", middle_click: "Middle-clicks", double_click: "Double-clicks", triple_click: "Triple-clicks" };

/**
 * Every step of the call in order, as he approves it: what each types or
 * pastes in full (never cut), what each clicks by the element the host bound,
 * the keys it presses. A batch is a list of these; a single act is one. Steps
 * that send nothing (a screenshot, a zoom) are left out.
 */
export function stepRows(args: Rec, targets: unknown): { label: string; value: string }[] {
  const steps = Array.isArray(args.actions) ? (args.actions as Rec[]) : typeof args.action === "string" ? [args] : [];
  const bound = Array.isArray(targets) ? (targets as Target[]) : [];
  const rows: { label: string; value: string }[] = [];
  // Where the focus is as the steps run: the element the host bound as focused when the call was held, then whatever
  // a step puts it on (a click, a set value, a typed text into a named element); a Tab or a step on no named element
  // leaves it unknown, said plainly.
  const focusAtHold = sigWords(bound.find((x) => x.param === "focus")?.sig);
  let focus: string | null = focusAtHold;
  steps.forEach((a, i) => {
    const where = (param: string, point: unknown, element: unknown): string => {
      const t = bound.find((x) => x.step === i && x.param === param) ?? (param === "element" ? bound.find((x) => x.step === i && x.param === "point") : undefined);
      const name = sigWords(t?.sig);
      if (name) return name;
      if (Array.isArray(point) && point.length === 2) return `the point ${point[0]},${point[1]}`;
      if (typeof element === "number") return `element ${element}`;
      return "where the cursor is";
    };
    const on = () => where("element", a.coordinate, a.element);
    const text = typeof a.text === "string" ? a.text : null;
    // A typed text, a paste or a key goes to its own element when it names one (bound by the host), else to the focus.
    const own = sigWords((bound.find((x) => x.step === i && x.param === "element") ?? bound.find((x) => x.step === i && x.param === "point"))?.sig);
    const intoWhat = (): string => {
      if (own) return own;
      if (typeof a.element === "number") return `element ${a.element}`;
      return focus ?? "the focus";
    };
    switch (a.action) {
      case "type":
        if (text !== null) rows.push({ label: "Types", value: `into ${intoWhat()}: ${text}` });
        break;
      case "paste":
        if (text !== null) rows.push({ label: "Pastes", value: `into ${intoWhat()}: ${text}` });
        break;
      case "set_value":
        rows.push({ label: "Sets", value: `${on()} to ${JSON.stringify(typeof a.value === "string" ? a.value : (text ?? ""))}` });
        break;
      case "key":
        if (text !== null) rows.push({ label: "Presses", value: `${text}${num(a.repeat) && (a.repeat as number) > 1 ? `, ${a.repeat} times` : ""}, in ${intoWhat()}` });
        break;
      case "hold_key":
        if (text !== null) rows.push({ label: "Holds", value: `${text}${num(a.duration) ? ` for ${a.duration} s` : ""}, in ${intoWhat()}` });
        break;
      case "left_click_drag":
        rows.push({ label: "Drags", value: `from ${where("start_element", a.start_coordinate, a.start_element)} to ${on()}` });
        break;
      case "scroll":
        rows.push({ label: "Scrolls", value: `${str(a.scroll_direction) ?? "down"}${num(a.scroll_amount) ? ` ${a.scroll_amount}` : ""} at ${on()}` });
        break;
      case "perform":
        rows.push({ label: "Performs", value: `${str(a.name) ?? "an action"} on ${on()}` });
        break;
      case "select_text": {
        // What it finds (its first match, narrowed by the words right around it, or a span of characters), in which
        // field, and whether it selects that or only puts the caret beside it: "select Pay" and "caret after Pay"
        // then paste the same text to different ends.
        // A prefix or suffix of spaces alone still picks another occurrence (TextMatch.swift `findText`): every one
        // given is shown, untrimmed, quoted with its invisible characters escaped.
        const range = Array.isArray(a.range) && a.range.length === 2 ? `characters ${a.range[0]} to ${a.range[1]}` : null;
        const given = (v: unknown): v is string => typeof v === "string" && v.length > 0;
        const around = [given(a.prefix) ? `right after ${exactQuote(a.prefix)}` : "", given(a.suffix) ? `right before ${exactQuote(a.suffix)}` : ""].filter(Boolean).join(" and ");
        const match = range ?? `the first ${exactQuote(text ?? "")}${around ? ` ${around}` : ""}`;
        const place = str(a.place);
        if (place === "before" || place === "after") rows.push({ label: "Puts the caret", value: `${place} ${match} in ${intoWhat()}` });
        else rows.push({ label: "Selects", value: `${match} in ${intoWhat()}` });
        break;
      }
      case "save_as":
        rows.push({ label: "Saves as", value: str(a.path) ?? str(a.named) ?? "a file" });
        break;
      case "mouse_move":
        rows.push({ label: "Moves to", value: on() });
        break;
      case "left_mouse_down":
      case "left_mouse_up":
        rows.push({ label: a.action === "left_mouse_down" ? "Presses the mouse" : "Lets go of the mouse", value: on() });
        break;
      default:
        if (typeof a.action === "string" && CLICK[a.action]) rows.push({ label: CLICK[a.action]!, value: on() });
        else if (typeof a.action === "string" && !["screenshot", "zoom", "cursor_position", "wait"].includes(a.action))
          rows.push({ label: a.action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), value: text ?? on() });
    }
    // Where this step leaves the focus, for the steps after it.
    const action = typeof a.action === "string" ? a.action : "";
    const named = own ?? (typeof a.element === "number" ? `element ${a.element}` : null);
    if (CLICK[action] || action === "set_value" || action === "select_text" || action === "left_mouse_down") focus = named;
    else if ((action === "type" || action === "paste" || action === "key" || action === "hold_key") && named) focus = named;
    if ((action === "key" || action === "hold_key") && /\btab\b/i.test(text ?? "")) focus = null;
  });
  return rows;
}

// ── an agent's change to a shared file ───────────────────────────────────

const EDIT_APP: Record<string, string> = { word: "Word", powerpoint: "PowerPoint", doc: "Google Docs", slides: "Google Slides" };

/** Each change as he approves it, in full: the words it replaces and what takes their place, a box's words before and after, or what it adds. */
export function editRows(edits: unknown): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  for (const raw of Array.isArray(edits) ? edits : []) {
    const e = (raw ?? {}) as Rec;
    if (typeof e.find === "string") {
      if (str(e.replace) === null) rows.push({ label: "Take out", value: e.find });
      else rows.push({ label: "Replace", value: e.find }, { label: "With", value: e.replace as string });
    } else if (typeof e.shape === "string") {
      rows.push({ label: num(e.slide) === null ? "A box" : `Slide ${e.slide}`, value: str(e.was) ?? "" }, { label: "Becomes", value: typeof e.text === "string" ? e.text : "" });
    }
  }
  return rows;
}

// ── a Frame.io comment's marks ───────────────────────────────────────────

/** A share of the frame as a percentage, exact (the value that goes, float noise trimmed): 31%, 15.5%, 12.3456%. */
const pct = (n: unknown): string => (typeof n === "number" ? `${+(n * 100).toPrecision(10)}%` : "?");
const at2 = (x: unknown, y: unknown): string => `${pct(x)} across, ${pct(y)} down`;

/** A mark's colour as a word: the hue's name, or white, grey or black. */
export function colourWord(hex: unknown): string {
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) return "";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
  if (sat < 0.2) return light > 0.85 ? "white" : light < 0.15 ? "black" : "grey";
  const d = max - min;
  const hue = (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  const h = (hue + 360) % 360;
  return h < 15 || h >= 345 ? "red" : h < 45 ? "orange" : h < 70 ? "yellow" : h < 160 ? "green" : h < 200 ? "teal" : h < 255 ? "blue" : h < 290 ? "purple" : "pink";
}

/** One row per mark: the pin, then each shape's kind, where it is, how big and its colour. */
/** A mark's line as Frame.io draws it: its share of the frame's height in pixels, at least 1 (frameio/map.ts `pixels`). */
const thickness = (width: unknown, height: number): string => (typeof width === "number" ? `, ${Math.max(1, Math.round(width * height))} px thick` : "");

export function markRows(pin: unknown, shapes: unknown, height: unknown = 1080): { label: string; value: string }[] {
  const h = typeof height === "number" && height > 0 ? height : 1080;
  const rows: { label: string; value: string }[] = [];
  if (pin && typeof pin === "object") rows.push({ label: "Pin", value: `at ${at2((pin as Rec).x, (pin as Rec).y)}` });
  for (const raw of Array.isArray(shapes) ? shapes : []) {
    const s = (raw ?? {}) as Rec;
    const colour = colourWord(s.color);
    const tail = `${colour ? `, ${colour}` : ""}${thickness(s.width, h)}`;
    let words: string | null = null;
    if (s.tool === "rect") words = `A box at ${at2(s.x, s.y)}, ${pct(s.w)} wide and ${pct(s.h)} high${tail}`;
    else if (s.tool === "ellipse")
      words = `An oval centred ${at2(s.cx, s.cy)}, ${pct(typeof s.rx === "number" ? s.rx * 2 : undefined)} wide and ${pct(typeof s.ry === "number" ? s.ry * 2 : undefined)} high${tail}`;
    else if (s.tool === "line" || s.tool === "arrow") words = `${s.tool === "line" ? "A line" : "An arrow"} from ${at2(s.x1, s.y1)} to ${at2(s.x2, s.y2)}${tail}`;
    else if (s.tool === "pen") {
      // Every point, in order: Frame.io gets a straight line between each pair (frameio/map.ts), so the whole path is what goes.
      const pts = Array.isArray(s.points) ? (s.points as unknown[][]) : [];
      if (pts.length === 1) words = `A single point at ${at2(pts[0]![0], pts[0]![1])}, which Frame.io does not draw${tail}`;
      else if (pts.length > 1) words = `A drawn line through ${pts.map((pt) => at2(pt[0], pt[1])).join("; ")}${tail}`;
    }
    if (words) rows.push({ label: "Mark", value: words });
  }
  return rows;
}

/**
 * The detail's heading for a kind whose rows carry the rest, so each fact is
 * said once there (the list keeps the whole summary): a form's publish names
 * the form, a Google share the file (Person and Access are rows), a Teams post
 * nothing but the act (the chat is the In row, the post the body). Null for
 * any other kind: its heading is its summary's act. `sent` gives the past.
 */
export function kindHeading(kind: string, payload: unknown, sent: boolean): string | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Rec;
  switch (kind) {
    case "form.publish": {
      const title = str(p.title);
      return title ? `${sent ? "Published" : "Publish"} ${title}` : null;
    }
    case "share.google": {
      const name = str(p.name);
      return name ? `${sent ? "Shared" : "Share"} ${name}` : null;
    }
    case "teams.post":
      return typeof p.html === "string" ? null : sent ? "Posted in Teams" : "Post in Teams";
    case "office.edit":
    case "google.edit": {
      const name = str(p.name);
      return name ? `${sent ? "Changed" : "Change"} ${name}` : null;
    }
    default:
      return null;
  }
}

export function kindRows(kind: string, payload: unknown): KindRows | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Rec;
  switch (kind) {
    case "form.publish": {
      const n = num(p.questions);
      // The form's name is the heading's (kindHeading), said once.
      return { fields: row("Questions", n === null ? null : String(n)), body: str(p.content) };
    }
    case "share.google": {
      const role = str(p.role);
      return {
        fields: [
          ...row("Person", str(p.email)),
          ...row("Access", role ? (ACCESS[role] ?? role) : null),
          // The Google account the file is shared from: the one place it is said.
          ...row("Account", str(p.account)),
          ...(p.notify === true ? [{ label: "Notice", value: "Tells them by mail" }] : []),
        ],
        body: null,
      };
    }
    case "frameio.post": {
      if (p.what === "version") {
        const size = num(p.size);
        return {
          fields: [...row("On top of", str(p.ontoName)), ...row("File", str(p.name)), ...row("Size", size === null ? null : megabytes(size)), ...row("From", str(p.from))],
          body: null,
        };
      }
      const span = num(p.durationFrames);
      const at = str(p.clock);
      const marks = marksWords(p.pin, p.shapes);
      return {
        fields: [
          ...row("File", str(p.fileName)),
          ...row("At", at ? (span && span > 1 ? `${at}, for ${span} frames` : at) : null),
          // Each mark where it lands and how big, so two posts that differ only there never read the same.
          ...markRows(p.pin, p.shapes, p.height),
          ...row("Goes as", marks.changes),
        ],
        body: str(p.text),
      };
    }
    case "teams.post":
      // The post is the body at any length; with html beside it, the generic reader reads the html, which is what goes.
      return typeof p.html === "string" ? null : { fields: row("In", str(p.chat)), body: str(p.text) };
    case "computer.act": {
      // What he approves: the app and window it acts in, the page, and what the step lands on. The title is the heading,
      // the label the Send button, and the raw arguments (an index, coordinates) say nothing the kept picture does not.
      const app = p.app && typeof p.app === "object" ? str((p.app as Rec).name) : str(p.app);
      const args = (p.args && typeof p.args === "object" ? p.args : {}) as Rec;
      const read = (p.read && typeof p.read === "object" ? p.read : {}) as Rec;
      return {
        fields: [...row("App", app), ...row("Window", str(p.window)), ...row("URL", str(args.url)), ...row("On", str(read.on)), ...stepRows(args, p.targets)],
        body: null,
      };
    }
    case "office.edit": {
      // A Word insert's text is the body; a find and replace are rows, each in full.
      const e = (p.edit && typeof p.edit === "object" ? p.edit : {}) as Rec;
      const insert = typeof e.insert === "string" ? e.insert : null;
      return {
        fields: [...row("In", EDIT_APP[str(p.app) ?? ""] ?? null), ...(insert === null ? editRows([e]) : row("Adds at", e.at === "start" ? "The start" : "The end"))],
        body: insert,
      };
    }
    case "google.edit":
      return { fields: [...row("In", EDIT_APP[str(p.app) ?? ""] ?? null), ...editRows(p.edits), ...row("Account", str(p.account))], body: null };
    default:
      return null;
  }
}
