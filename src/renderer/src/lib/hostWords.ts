/** A host's name as it reads mid-line (docs/DESIGN.md, one name a thing): "The box" is "the box", a host's name and not a proper noun; "MacBook" stays. */
export const nameInLine = (name: string): string => (/^The [a-z]/.test(name) ? `t${name.slice(1)}` : name);
