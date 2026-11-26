import { useRef, type RefObject } from "react";
import { Button } from "../components/ui/button";
import { Combobox, ComboboxCollection, ComboboxEmpty, ComboboxGroup, ComboboxItem, ComboboxLabel, ComboboxList, ComboboxSearch } from "../components/ui/combobox";
import { Kbd } from "../components/ui/kbd";
import { reveal } from "../components/ui/reveal";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { keyHint, modOrCtrl } from "../lib/keys";
import type { AgentModel } from "../lib/models";
import type { HarnessId } from "../lib/session";
import { HarnessIcon } from "./HarnessIcon";
import { Check, Star } from "./icons";

/** The heading over a maker's rows in a harness tab. */
const VENDOR_TITLE: Record<NonNullable<AgentModel["vendor"]>, string> = { meta: "Meta" };

type Run = { value: string; vendor?: NonNullable<AgentModel["vendor"]>; items: AgentModel[] };

/** The rows in runs: in a harness tab a maker's rows (they come last, `ownThenVendor`) are a group under its name. */
function runsOf(grouped: boolean, models: AgentModel[]): Run[] {
  const split = grouped ? models.findIndex((m) => m.vendor) : -1;
  if (split < 0) return models.length ? [{ value: "own", items: models }] : [];
  const own = models.slice(0, split);
  return [...(own.length ? [{ value: "own", items: own }] : []), { value: models[split].vendor!, vendor: models[split].vendor!, items: models.slice(split) }];
}

/**
 * The model picker's open body: the field that searches every provider and
 * the list under it. The field is the list's combobox
 * (components/ui/combobox.tsx), so the arrows move the row a reader hears and
 * a row sliding under a still pointer never takes the highlight; the list
 * opens on the model in use. The picker filters and orders the rows itself;
 * ⌘1 to ⌘9 pick by place. It shows only inside the open popover, so it rides
 * the menu chunk (chrome/menuBody.tsx), never the first paint; the picker hands
 * it a harness's name and why one cannot run, so the chunk carries no catalog
 * or session code of its own.
 */
export function ModelRows({
  search,
  query,
  available,
  harnessTitle,
  unavailableHint,
  models,
  currentId,
  favorites,
  grouped,
  emptyLabel,
  onQuery,
  onPick,
  onToggleFavorite,
}: {
  search?: RefObject<HTMLInputElement | null>;
  query: string;
  available: (id: HarnessId) => boolean;
  /** A harness's name, beside a row out of its own tab. */
  harnessTitle: (id: HarnessId) => string;
  /** Why a harness cannot run on this host: a held row's tooltip. */
  unavailableHint: (id: HarnessId) => string;
  models: AgentModel[];
  currentId: string;
  favorites: string[];
  /** A harness tab: a maker's rows sit under its heading. */
  grouped: boolean;
  emptyLabel: string;
  onQuery: (query: string) => void;
  onPick: (model: AgentModel) => void;
  onToggleFavorite: (id: string) => void;
}) {
  const current = models.find((item) => item.id === currentId) ?? null;
  // The row the arrows or a typed query stand on, for an Enter with none: the first row then.
  const highlighted = useRef<AgentModel | undefined>(undefined);
  const pick = (item: AgentModel | undefined) => {
    if (item && available(item.harness)) onPick(item);
  };
  return (
    <Combobox<AgentModel>
      inline
      open
      items={runsOf(grouped, models)}
      filter={null}
      value={current}
      inputValue={query}
      autoHighlight
      itemToStringLabel={(item) => item.name}
      isItemEqualToValue={(a, b) => a.id === b.id}
      onInputValueChange={(next, details) => {
        // A pick never writes its row's name into the field: only typing changes the query.
        if (details.reason === "input-change" || details.reason === "input-clear") onQuery(next);
      }}
      onItemHighlighted={(item) => {
        highlighted.current = item;
      }}
    >
      <ComboboxSearch
        ref={search}
        placeholder="Search models"
        aria-label="Search models"
        // A bordered field over its list, as before; its glyph stands on the rows' 12px inset.
        className="mb-1 border-input"
        onKeyDown={(event) => {
          if (event.key === "Enter" && !highlighted.current) {
            event.preventDefault();
            pick(models[0]);
            return;
          }
          if (modOrCtrl(event) && !event.altKey && !event.shiftKey && event.key >= "1" && event.key <= "9") {
            event.preventDefault();
            pick(models[Number(event.key) - 1]);
          }
        }}
      />
      <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
      <ComboboxList aria-label="Models" className="max-h-[340px]">
        {(run: Run) => (
          <ComboboxGroup key={run.value} items={run.items} data-vendor-group={run.vendor}>
            {run.vendor ? (
              <ComboboxLabel className="flex items-center gap-2 pt-2">
                <HarnessIcon harness={run.vendor} className="size-3 shrink-0" />
                {VENDOR_TITLE[run.vendor]}
              </ComboboxLabel>
            ) : null}
            <ComboboxCollection>
              {(item: AgentModel) => {
                const index = models.indexOf(item);
                const selected = item.id === currentId;
                const favorited = favorites.includes(item.id);
                const disabled = !available(item.harness);
                const shortcut = index < 9 && !disabled ? keyHint(`mod+${index + 1}`) : null;
                const row = (
                  <ComboboxItem
                    key={item.id}
                    value={item}
                    disabled={disabled}
                    indicator={false}
                    onClick={() => pick(item)}
                    // MENU_ROW's box, its 4px of padding dropped so the 24px star keeps the row at 28px. A row its
                    // host cannot run stays under the pointer, so its reason shows on hover.
                    className="group/model py-0 data-disabled:pointer-events-auto data-disabled:text-muted-foreground data-disabled:opacity-60"
                  >
                    {/* No row draws a glyph, so every label starts on one edge; a maker's mark is its group heading's. */}
                    <span className="flex min-w-0 flex-1 items-baseline gap-1">
                      <span className="min-w-0 truncate">{item.name}</span>
                      {/* Out of its tab (search, favorites) a row names its harness: one model is offered under several. */}
                      {grouped ? null : (
                        <span data-model-harness className="shrink-0 text-xs text-muted-foreground">
                          {harnessTitle(item.harness)}
                        </span>
                      )}
                    </span>
                    {selected ? <Check className="size-3.5 shrink-0" /> : null}
                    {/* A favourite's star stays; any other row's waits on the shared hover reveal. */}
                    <span className={cn("flex", !favorited && reveal("model"))}>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFavorite(item.id);
                        }}
                        className={favorited ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
                      >
                        <Star fill={favorited ? "currentColor" : "none"} />
                      </Button>
                    </span>
                    {shortcut ? (
                      <Kbd size="sm" className="border-transparent bg-transparent text-muted-foreground">
                        {shortcut}
                      </Kbd>
                    ) : null}
                  </ComboboxItem>
                );
                if (!disabled) return row;
                return (
                  <Tooltip key={item.id}>
                    <TooltipTrigger render={row} />
                    <TooltipContent side="right">{unavailableHint(item.harness)}</TooltipContent>
                  </Tooltip>
                );
              }}
            </ComboboxCollection>
          </ComboboxGroup>
        )}
      </ComboboxList>
    </Combobox>
  );
}
