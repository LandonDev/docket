import type { Root } from "mdast";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm, type Options } from "micromark-extension-gfm";
import type { Processor } from "unified";

/**
 * remark-gfm's reading half: electron.vite.config.ts aliases the package `remark-gfm` to this file.
 *
 * The package adds GFM (tables, task lists, strikethrough, footnotes, bare links) to reading markdown and to
 * writing it again. Nothing in the window writes markdown: streamdown and our pipeline only parse it to a tree.
 * The writing half pulled `mdast-util-to-markdown` (37 kB) into the first paint. This file registers the same
 * reading extensions in the same order and nothing else; remarkGfmRead.test.ts holds its trees equal to the
 * package's over every GFM construct.
 */
export default function remarkGfmRead(this: Processor<Root>, options?: Options | null): undefined {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push(gfm(options ?? {}));
  (data.fromMarkdownExtensions ??= []).push(gfmFromMarkdown());
}
