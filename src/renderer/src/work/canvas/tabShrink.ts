/**
 * How readily a tab gives up width past what fits, in Files' row (files/TabRow.tsx) and the canvas tab row
 * (CanvasTabs.tsx) alike. The selected tab keeps its whole name (up to the tab's 240px) while any other has room to
 * give; the others give in step with their name's share of the tab, so each loses the same part of its name. Flex
 * takes from each tab in step with its whole width, the glyph and the close's room (about 9 letters) included, which
 * cut a short name ("Events") to a letter while long ones kept most.
 */
export const tabShrink = (name: string, selected = false): number => (selected ? 0 : name.length / (name.length + 9));
