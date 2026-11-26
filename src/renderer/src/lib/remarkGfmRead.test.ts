import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import remarkGfmRead from "./remarkGfmRead";

const SAMPLE = [
  "| a | b |", "| :- | -: |", "| 1 | ~~2~~ |", "",
  "- [ ] open", "- [x] done", "",
  "See www.example.com, https://example.com/x?y=1 and someone@example.com.", "",
  "A note[^1] and ~one~ ~~two~~ strikes.", "", "[^1]: The footnote, *with* emphasis.", "",
  "```ts", "const x = 1", "```", "",
  "<b>raw</b> and a \\| pipe",
].join("\n");

const tree = (plugin: typeof remarkGfm, options?: Parameters<typeof remarkGfm>[0]) =>
  unified().use(remarkParse).use(plugin, options).parse(SAMPLE);

describe("remark-gfm's reading half", () => {
  it("reads every GFM construct to the tree the package reads", () => {
    const read = unified().use(remarkParse).use(remarkGfmRead).parse(SAMPLE);
    expect(read).toEqual(tree(remarkGfm));
    // The tree has the constructs it should, so equality is not two empty trees.
    const kinds = new Set<string>();
    const walk = (n: { type: string; children?: unknown[] }): void => {
      kinds.add(n.type);
      for (const c of (n.children ?? []) as { type: string }[]) walk(c);
    };
    walk(read as never);
    for (const kind of ["table", "delete", "footnoteReference", "footnoteDefinition", "link", "listItem"]) expect(kinds, kind).toContain(kind);
  });

  it("takes the same options: single tildes off", () => {
    const read = unified().use(remarkParse).use(remarkGfmRead, { singleTilde: false }).parse(SAMPLE);
    expect(read).toEqual(tree(remarkGfm, { singleTilde: false }));
  });

  it("registers no writer", () => {
    const processor = unified().use(remarkParse).use(remarkGfmRead);
    processor.freeze();
    expect((processor.data() as { toMarkdownExtensions?: unknown[] }).toMarkdownExtensions).toBeUndefined();
  });
});
