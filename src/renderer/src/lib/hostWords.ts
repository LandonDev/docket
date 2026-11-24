/**
 * A host's name as it reads mid-line (docs/DESIGN.md, one name a thing): "The box" is "the box" and "This Mac" is "this
 * Mac" (the registry's words for this machine, "This PC" and a browser's "This host" alike), a host's name and not a
 * proper noun; "MacBook" and "The Purdue Office" stay.
 */
export const nameInLine = (name: string): string => (/^(The [a-z]|This )/.test(name) ? `t${name.slice(1)}` : name);
