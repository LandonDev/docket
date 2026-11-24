/**
 * A tab's name in Files' row (files/TabRow.tsx) and the canvas tab row (CanvasTabs.tsx) alike. Squeezed under the room
 * of one letter and its ellipsis, the name gives way whole, and the tab is its glyph alone (docs/DESIGN.md "Spacing":
 * the least fact gives way first, and whole), never a sliver of its first letter. The name stays its accessible name,
 * and its tip still shows it whole. The name's box is a container, so it is measured by the room the tab gives it;
 * an unseen copy of the name beside it (the `::before`, from `data-name`) gives the tab its width while it has room.
 */
export function TabName({ name, titleRef }: { name: string; titleRef: (el: HTMLElement | null) => void }) {
  return (
    <span
      data-tab-name={name}
      className="grid min-w-0 before:invisible before:col-start-1 before:row-start-1 before:h-0 before:overflow-hidden before:whitespace-nowrap before:content-[attr(data-tab-name)]"
    >
      <span className="@container/tab-name col-start-1 row-start-1 min-w-0">
        <span ref={titleRef} className="block min-w-0 truncate @max-[1.25rem]/tab-name:sr-only">
          {name}
        </span>
      </span>
    </span>
  );
}
