import { useEffect } from "react";
import { PageEmpty } from "../../components/page";
import { usePointerHighlight } from "../../hooks/usePointerHighlight";
import { cn } from "../../lib/cn";
import { requestSettings } from "../../lib/monaco/debugTab";
import { inMaySheet, openMaySheet } from "../../lib/settings/maySheet";
import { searchSettings, type SearchResult } from "../../lib/settings/search";
import { settingsSearch, useSettingsSearch } from "../../lib/settings/searchStore";
import { settingsList } from "../../lib/settings/list";
import { useListWindow } from "../../lib/settings/useListWindow";
import { thisDesktopInLine } from "../../lib/native";
import { LOCAL_ENVIRONMENT_ID } from "../../lib/connection";
import { useWorkHosts } from "../../lib/workSwitch";
import { ItemButton } from "../../components/ui/item";
import { addonNames } from "./addons/useAddons";
import { skillNames } from "./skills/useSkills";

/** The results' title: the field beside it already says what was typed. */
export const RESULTS_TITLE = "Results";

/** Opens a result: its page, scrolled to its row with the fill held on it; the field is cleared so the list shows where he is. */
export function openResult(result: SearchResult): void {
  settingsSearch.clear();
  // A row in what a computer may do on this Mac is its sheet's: the page lands on the computer's row and the sheet opens.
  if (result.computer && result.row && inMaySheet(result.row)) {
    requestSettings(result.page, "sharing.may");
    openMaySheet(result.computer);
    return;
  }
  requestSettings(result.page, result.row);
}

/** The results for what is typed, in this window. */
export function useSearchResults(): SearchResult[] {
  const { query } = useSettingsSearch();
  const window = useListWindow();
  // Add-ons and skills by name: asked once, here, inside Settings.
  const addons = addonNames.useExtras();
  const skills = skillNames.useExtras();
  const workHere = useWorkHosts().has(LOCAL_ENVIRONMENT_ID);
  return searchSettings(query, settingsList(window), { mac: thisDesktopInLine() }, [...addons, ...skills], { web: window.web, mac: window.platform === "darwin", work: window.work, workHere });
}

/**
 * Search's results, in the page's place (docs/agents/settings.md "Search"): each a setting's name with where it is
 * under it, and its old name when that is what was typed. The field keeps the caret; ↑ and ↓ move the highlight here
 * and Enter opens it, on the house's keyboard list (`usePointerHighlight`).
 */
export function SearchResults() {
  const { query, active } = useSettingsSearch();
  const results = useSearchResults();
  const at = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute("data-settings-search")) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (results.length) settingsSearch.setActive((at + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
      } else if (event.key === "Enter" && results[at]) {
        event.preventDefault();
        openResult(results[at]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [results, at]);

  return <SearchResultsView results={results} active={at} query={query} onActive={settingsSearch.setActive} onOpen={openResult} />;
}

/** The results as they draw, for a query: the store's (SearchResults) or a fixture's. */
export function SearchResultsView({
  results,
  active,
  query,
  onActive,
  onOpen,
}: {
  results: readonly SearchResult[];
  active: number;
  query: string;
  onActive: (index: number) => void;
  onOpen: (result: SearchResult) => void;
}) {
  const { activeRef, onMouseMove, onRowEnter } = usePointerHighlight<HTMLButtonElement>({ active, items: results, onActive });
  if (!results.length) return <PageEmpty>Nothing in Settings matches “{query.trim()}”</PageEmpty>;
  return (
    <div role="listbox" aria-label="Search results" onMouseMove={onMouseMove} className="-mx-2 flex flex-col">
      {results.map((result, index) => (
        <ItemButton
          key={result.key}
          ref={index === active ? activeRef : undefined}
          role="option"
          aria-selected={index === active}
          data-result={result.row ?? result.page}
          // The caret stays in the field.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onRowEnter(index)}
          onClick={() => onOpen(result)}
          className={cn("min-w-0 flex-col flex-nowrap items-stretch gap-0.5 rounded-md border-0 px-2 py-2 text-left transition-none", index === active && "bg-muted")}
        >
          <span className="truncate text-[13px] leading-5 text-foreground">{result.title}</span>
          {result.path ? <span className="truncate text-xs text-muted-foreground">{result.path}</span> : null}
          {result.was ? <span className="truncate text-xs text-muted-foreground">{result.was}</span> : null}
        </ItemButton>
      ))}
    </div>
  );
}
