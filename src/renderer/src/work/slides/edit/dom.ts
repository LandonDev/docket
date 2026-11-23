import { fontStack } from "work-kit/fonts";
import { DEFAULT_SIZE, normalize, type EditPara, type EditRun, type Model, type Point, type RunLook, type Sel } from "./model";

/**
 * The typing box's words in the page (docs/agents/work-slides.md "Typing on
 * a slide"). The model is drawn as one block a paragraph (`data-p`, its index
 * in the model drawn) holding one span a run (`data-r`, "paragraph:run"), so
 * what the browser does to them while he types (a word typed into a span, two
 * paragraphs joined by Backspace) is read back run by run. A line break is a
 * `<br>`; a block that is empty or ends in a break holds one more, the
 * browser's own, which is no character.
 */

/** EMU to an inch, and to a point. */
const EMU_INCH = 914_400;
const EMU_POINT = 12_700;

/** How a run is drawn at `emu` CSS pixels an EMU. */
export function runCss(look: RunLook, emu: number): Partial<CSSStyleDeclaration> {
  return {
    fontFamily: fontStack(look.font ?? "Calibri"),
    fontSize: `${(look.size ?? DEFAULT_SIZE) * EMU_POINT * emu}px`,
    fontWeight: look.bold ? "700" : "400",
    fontStyle: look.italic ? "italic" : "normal",
    textDecoration: look.underline ? "underline" : "none",
    color: look.color ? `#${look.color}` : "",
  };
}

/** Draws the model into the box, in place of what it held. */
export function paint(root: HTMLElement, model: Model, emu: number): void {
  const doc = root.ownerDocument;
  root.replaceChildren(
    ...model.map((para, p) => {
      const block = doc.createElement("div");
      block.dataset.p = String(p);
      const first = para.runs[0]?.look ?? para.look;
      Object.assign(block.style, {
        textAlign: para.align === "center" ? "center" : para.align,
        fontSize: runCss(first, emu).fontSize,
        color: runCss(first, emu).color,
        // A level is half an inch in, as PowerPoint's own lists are; a list's mark hangs in the first quarter of it.
        marginInlineStart: `${(para.level * EMU_INCH * 0.5 + (para.list === "none" ? 0 : EMU_INCH * 0.375)) * emu}px`,
        ...(para.list === "none"
          ? { counterReset: "list-item" }
          : { display: "list-item", listStyleType: para.list === "bullet" ? "disc" : "decimal", listStylePosition: "outside" }),
      } satisfies Partial<CSSStyleDeclaration>);
      para.runs.forEach((run, r) => {
        const el = doc.createElement("span");
        el.dataset.r = `${p}:${r}`;
        Object.assign(el.style, runCss(run.look, emu));
        run.text.split("\n").forEach((piece, i) => {
          if (i > 0) el.append(doc.createElement("br"));
          if (piece) el.append(doc.createTextNode(piece));
        });
        block.append(el);
      });
      if (para.runs.length === 0 || paraEndsInBreak(para)) block.append(doc.createElement("br"));
      return block;
    }),
  );
}

const paraEndsInBreak = (para: EditPara): boolean => para.runs[para.runs.length - 1]?.text.endsWith("\n") ?? false;

const isBlock = (node: Node): node is HTMLElement => node.nodeType === 1 && ((node as HTMLElement).dataset.p !== undefined || /^(DIV|P|LI)$/.test(node.nodeName));
const isBreak = (node: Node): boolean => node.nodeName === "BR";

/** The pieces a block's words are made of, in order: text and breaks. The last break of a block, with no text after it, is the browser's and no character. */
function atomsOf(block: Node): Node[] {
  const atoms: Node[] = [];
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if ((child as Text).data) atoms.push(child);
      } else if (isBreak(child)) atoms.push(child);
      else walk(child);
    }
  };
  walk(block);
  const last = atoms[atoms.length - 1];
  if (last && isBreak(last)) atoms.pop();
  return atoms;
}

/** The paragraphs of the box: its blocks, and any words the browser left outside one, as one more. */
function blocksOf(root: HTMLElement): Node[][] {
  const out: Node[][] = [];
  let loose: Node[] | null = null;
  for (const child of root.childNodes) {
    if (isBlock(child)) {
      loose = null;
      out.push([child]);
    } else {
      if (!loose) out.push((loose = []));
      loose.push(child);
    }
  }
  return out;
}

const lengthOf = (atom: Node): number => (isBreak(atom) ? 1 : (atom as Text).data.length);

/**
 * The box's words read back into the model, against the model last drawn
 * into it: each piece of text belongs to the run whose span holds it, and a
 * piece in none (the browser's own) to the run before it in its paragraph.
 */
export function readModel(root: HTMLElement, drawn: Model): Model {
  const paras: EditPara[] = [];
  let lastPara: EditPara | undefined = drawn[0];
  for (const nodes of blocksOf(root)) {
    const block = nodes.length === 1 && isBlock(nodes[0]) ? (nodes[0] as HTMLElement) : null;
    const source: EditPara = (block?.dataset.p !== undefined ? drawn[Number(block.dataset.p)] : undefined) ?? lastPara ?? drawn[0];
    lastPara = source;
    const atoms = nodes.flatMap((node) => (isBlock(node) ? atomsOf(node) : node.nodeType === 3 ? ((node as Text).data ? [node] : []) : isBreak(node) ? [node] : atomsOf(node)));
    const runs: EditRun[] = [];
    let open: EditRun | null = null;
    let openKey: string | null = null;
    for (const atom of atoms) {
      const holder = (atom.nodeType === 3 ? atom.parentElement : (atom as HTMLElement))?.closest<HTMLElement>("[data-r]");
      const key = holder && root.contains(holder) ? (holder.dataset.r ?? null) : null;
      const text = isBreak(atom) ? "\n" : (atom as Text).data;
      if (open && (key === null || key === openKey)) {
        open.text += text;
        continue;
      }
      const [p, r] = (key ?? "").split(":").map(Number);
      const from = key !== null ? drawn[p]?.runs[r] : undefined;
      open = from ? { ...from, text } : { text, ...(source.carry?.from ? { from: source.carry.from } : {}), look: { ...source.look, ...source.pending }, set: { ...source.carry?.set, ...source.pending } };
      openKey = key;
      runs.push(open);
    }
    paras.push({ ...source, runs });
  }
  if (paras.length === 0) paras.push({ ...(drawn[0] ?? { level: 0, align: "left", list: "none", set: {}, look: {}, pending: {} }), runs: [] });
  return normalize(paras);
}

/** Whether `a` comes before `b` in the page (and is not inside it). */
const precedes = (a: Node, b: Node): boolean => !!(b.compareDocumentPosition(a) & 2);

/** Where a place in the page is among the box's words, or null outside it. */
export function pointOf(root: HTMLElement, node: Node, offset: number): Point | null {
  if (!root.contains(node)) return null;
  const blocks = blocksOf(root);
  const atomsAt = (p: number): Node[] => blocks[p].flatMap((n) => (isBlock(n) ? atomsOf(n) : n.nodeType === 3 || isBreak(n) ? [n] : atomsOf(n)));
  const count = (atoms: Node[], before: (atom: Node) => boolean): number => atoms.filter(before).reduce((n, a) => n + lengthOf(a), 0);
  if (node === root) {
    const p = Math.min(offset, blocks.length) - 1;
    return p < 0 ? [0, 0] : [p, count(atomsAt(p), () => true)];
  }
  const p = blocks.findIndex((nodes) => nodes.some((n) => n === node || n.contains(node)));
  if (p < 0) return null;
  const atoms = atomsAt(p);
  if (node.nodeType === 3) return [p, count(atoms, (a) => a !== node && precedes(a, node)) + (atoms.includes(node) ? offset : 0)];
  const ref = node.childNodes[offset];
  return [p, count(atoms, ref ? (a) => precedes(a, ref) && !ref.contains(a) : (a) => node.contains(a) || precedes(a, node))];
}

/** A place among the box's words as a place in the page: at the end of the text before it, so typed words take that run's look. */
export function placeOf(root: HTMLElement, point: Point): [Node, number] {
  const blocks = blocksOf(root);
  const nodes = blocks[Math.min(point[0], blocks.length - 1)] ?? [];
  const block = nodes.length === 1 && isBlock(nodes[0]) ? nodes[0] : root;
  let left = point[1];
  for (const atom of nodes.flatMap((n) => (isBlock(n) ? atomsOf(n) : [n]))) {
    const length = lengthOf(atom);
    if (atom.nodeType === 3 && left <= length) return [atom, left];
    if (isBreak(atom) && left === 0) return [atom.parentNode!, [...atom.parentNode!.childNodes].indexOf(atom as ChildNode)];
    left -= length;
    if (isBreak(atom) && left === 0) {
      const next = atom.nextSibling;
      if (next?.nodeType === 3) return [next, 0];
      return [atom.parentNode!, [...atom.parentNode!.childNodes].indexOf(atom as ChildNode) + 1];
    }
  }
  return [block, block === root ? 0 : block.childNodes.length && isBreak(block.lastChild!) ? block.childNodes.length - 1 : block.childNodes.length];
}

/** The page's selection as a selection of the box's words, or null when it is not in the box. */
export function readSel(root: HTMLElement): Sel | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
  const a = pointOf(root, sel.anchorNode, sel.anchorOffset);
  const b = pointOf(root, sel.focusNode, sel.focusOffset);
  if (!a || !b) return null;
  return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? { from: a, to: b } : { from: b, to: a };
}

/** Puts the page's selection on a selection of the box's words. */
export function writeSel(root: HTMLElement, sel: Sel): void {
  const page = root.ownerDocument.getSelection();
  if (!page) return;
  const [an, ao] = placeOf(root, sel.from);
  const [fn, fo] = placeOf(root, sel.to);
  const range = root.ownerDocument.createRange();
  range.setStart(an, ao);
  range.setEnd(fn, fo);
  page.removeAllRanges();
  page.addRange(range);
}
