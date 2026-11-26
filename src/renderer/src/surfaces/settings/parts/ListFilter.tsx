import { useMemo, useState } from "react";
import { PageEmpty } from "../../../components/page";
import { Search } from "../../../chrome/icons";
import { GroupInput, InputGroup } from "../../../components/ui/input";

/** A list past this many rows gets a find field over it (docs/agents/settings.md "Lists are kept short"). */
export const LIST_FILTER_PAST = 8;

export type ListFilterState<T> = {
  /** The rows that match, in their order; all of them while nothing is typed. */
  shown: readonly T[];
  query: string;
  setQuery: (query: string) => void;
  /** The list is long enough to have the field. */
  offered: boolean;
};

/** Narrows a list by what he types: every typed word must be in the row's words, in any order and any case. */
export function filterList<T>(items: readonly T[], words: (item: T) => string, query: string): readonly T[] {
  const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!needles.length) return items;
  return items.filter((item) => {
    const text = words(item).toLowerCase();
    return needles.every((needle) => text.includes(needle));
  });
}

export function useListFilter<T>(items: readonly T[], words: (item: T) => string): ListFilterState<T> {
  const [query, setQuery] = useState("");
  const offered = items.length > LIST_FILTER_PAST;
  // A list that shrank under the field's limit drops what was typed with the field.
  const active = offered ? query : "";
  const shown = useMemo(() => filterList(items, words, active), [items, words, active]);
  return { shown, query: active, setQuery, offered };
}

/** The find field over a long list, and the one line it leaves when nothing matches; nothing at all for a short list. */
export function ListFilter<T>({ filter, label }: { filter: ListFilterState<T>; label: string }) {
  if (!filter.offered) return null;
  return (
    <>
      <InputGroup leading={<Search />} className="mb-1">
        <GroupInput role="searchbox" aria-label={label} placeholder={label} autoComplete="off" spellCheck={false} value={filter.query} onChange={(event) => filter.setQuery(event.target.value)} />
      </InputGroup>
      {filter.shown.length === 0 ? <PageEmpty>Nothing matches “{filter.query.trim()}”</PageEmpty> : null}
    </>
  );
}
