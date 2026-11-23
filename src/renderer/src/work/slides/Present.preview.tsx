// A preview frame for `bun run ui:preview src/renderer/src/work/slides/Present.preview.tsx#PresentMenuPreview --shot`:
// the Present menu's rows as they are drawn open, ending with "In PowerPoint" and its count of effects that play only
// there. A menu's popup mounts outside the preview's page, so the panel is drawn here with the menu's own classes.
import { Kbd } from "../../components/ui/kbd";
import { MENU_ROW } from "../../components/ui/menu-row";
import { effectsWords, InPowerPointRow, usePresentMenu } from "./Present";

function Rows() {
  const { rows } = usePresentMenu(() => undefined, null);
  return (
    <div role="menu" className="w-max min-w-60 rounded-xl bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-border">
      {rows.map((row, i) =>
        row.kind === "sep" ? (
          <div key={i} className="-mx-1 my-1.5 h-px bg-border" />
        ) : row.kind === "item" ? (
          <div key={row.id} role="menuitem" className={`${MENU_ROW} flex items-center rounded-lg ${i === 0 ? "bg-muted" : ""}`}>
            {row.description ? (
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{row.label}</span>
                <span className="text-xs text-muted-foreground">{row.description}</span>
              </span>
            ) : (
              <span className="min-w-0 truncate">{row.label}</span>
            )}
            {row.shortcut ? (
              <span className="ms-auto ps-4 text-xs text-muted-foreground">
                <Kbd size="sm">{row.shortcut}</Kbd>
              </span>
            ) : null}
          </div>
        ) : null,
      )}
    </div>
  );
}

export function PresentMenuPreview({ changed = 3 }: { changed?: number }) {
  return (
    <InPowerPointRow.Provider value={{ changed, present: () => undefined }}>
      <div className="p-2" data-words={effectsWords(changed)}>
        <Rows />
      </div>
    </InPowerPointRow.Provider>
  );
}
