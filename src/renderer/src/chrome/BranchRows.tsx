import { useRef, type RefObject } from "react";
import { Combobox, ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxSearch } from "../components/ui/combobox";
import type { GitBranchInfo } from "../lib/fs";
import { GitBranch, Plus } from "./icons";

export type BranchRow =
  | { kind: "create"; name: string }
  | { kind: "branch"; branch: GitBranchInfo };

type Row = BranchRow;

const keyOf = (row: Row): string => (row.kind === "create" ? `create:${row.name}` : `${row.branch.remote ?? "local"}:${row.branch.name}`);

/**
 * BranchPicker's open body: the field that searches or names a new branch,
 * and under it the create row and the branches. The field is the list's
 * combobox (components/ui/combobox.tsx), so the arrows move the row a reader
 * hears and a row sliding under a still pointer never takes the highlight;
 * the list opens on the current branch. The picker filters the rows itself.
 * It shows only inside the open popover, so it rides the menu chunk
 * (chrome/menuBody.tsx) instead of the first paint.
 */
export function BranchRows({
  search,
  query,
  rows,
  busy,
  emptyLabel,
  onQuery,
  onPick,
}: {
  search: RefObject<HTMLInputElement | null>;
  query: string;
  rows: Row[];
  busy: boolean;
  emptyLabel: string;
  onQuery: (query: string) => void;
  onPick: (row: Row) => void;
}) {
  const current = rows.find((row) => row.kind === "branch" && row.branch.current) ?? null;
  // The row the arrows or a typed query stand on, for an Enter with none: the first row then.
  const highlighted = useRef<Row | undefined>(undefined);
  return (
    <Combobox<Row>
      inline
      open
      items={rows}
      filter={null}
      value={current}
      inputValue={query}
      autoHighlight
      itemToStringLabel={(row) => (row.kind === "create" ? row.name : row.branch.name)}
      isItemEqualToValue={(a, b) => keyOf(a) === keyOf(b)}
      onInputValueChange={(next, details) => {
        // A pick never writes its row's name into the field: only typing changes the query.
        if (details.reason === "input-change" || details.reason === "input-clear") onQuery(next);
      }}
      onItemHighlighted={(row) => {
        highlighted.current = row;
      }}
    >
      <ComboboxSearch
        ref={search}
        placeholder="Search or create a branch"
        aria-label="Search or create a branch"
        disabled={busy}
        // A bordered field over its list, as before; its glyph stands over the rows' glyphs, 12px in.
        className="mb-1 border-input"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || highlighted.current || !rows[0]) return;
          event.preventDefault();
          onPick(rows[0]);
        }}
      />
      <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
      <ComboboxList aria-label="Branches">
        {(row: Row) => (
          <ComboboxItem key={keyOf(row)} value={row} disabled={busy} onClick={() => onPick(row)}>
            {row.kind === "create" ? (
              <>
                <Plus className="text-muted-foreground" />
                <span className="min-w-0 truncate">Create and checkout {row.name}</span>
              </>
            ) : (
              <>
                <GitBranch className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.branch.name}</span>
                {row.branch.remote ? <span className="shrink-0 text-xs text-muted-foreground">{row.branch.remote}</span> : null}
              </>
            )}
          </ComboboxItem>
        )}
      </ComboboxList>
    </Combobox>
  );
}
