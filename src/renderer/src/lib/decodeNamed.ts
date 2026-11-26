/**
 * micromark's decoder of a named character reference (`&amp;`): electron.vite.config.ts
 * aliases the package `decode-named-character-reference` to this file.
 *
 * The package has two builds. One reads a table of every name (about 30 kB); the other asks
 * the document, and a worker has none. The window's first paint carried the table only
 * because the parse worker needed it. Here the window asks the document and the worker
 * hands in the table (markdown.worker.ts), so the table rides the worker's file alone.
 * Both read the same HTML list of names: decodeNamed.dom.test.tsx holds them equal.
 */

type Entities = Readonly<Record<string, string>>;

// Kept on the global, not in this module: the dev server bundles its own copy of this file into
// micromark's pre-built chunk, and the worker's hand-in must reach that copy too.
const held = globalThis as { __docketCharacterEntities?: Entities | null };

/** A context with no document decodes from this table. */
export function provideCharacterEntities(entities: Entities | null): void {
  held.__docketCharacterEntities = entities;
}

const element = typeof document === "undefined" ? null : document.createElement("i");

export function decodeNamedCharacterReference(value: string): string | false {
  const table = held.__docketCharacterEntities;
  if (table) return Object.hasOwn(table, value) ? table[value]! : false;
  if (!element) throw new Error("decodeNamed: no document here and no table handed in (provideCharacterEntities)");
  const characterReference = "&" + value + ";";
  element.innerHTML = characterReference;
  const character = element.textContent ?? "";
  // A name that needs no semicolon (`&not`) matches the start of a longer word (`&notit;`
  // reads "¬it;"): a semicolon left at the end means the whole name was not one.
  if (character.charCodeAt(character.length - 1) === 59 && value !== "semi") return false;
  return character === characterReference ? false : character;
}
