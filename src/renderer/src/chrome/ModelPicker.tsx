import { keyHint, modOrCtrl } from "../lib/keys";
import { ChevronDown, Star } from "./icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/lazy-menus";
import { Separator } from "../components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { ROW_CONTROL } from "./composerRow";
import {
  allModels,
  coerceModelPickerTab,
  findModel,
  getModelSnapshot,
  getPickerVisibilitySnapshot,
  hasLiveCatalog,
  loadFavoriteModels,
  loadModelPickerTab,
  mergeModelSettings,
  modelsFor,
  resolveModel,
  saveFavoriteModels,
  saveModelPickerTab,
  showProviderInModelPicker,
  stepModelPickerTab,
  subscribeModels,
  subscribePickerVisibility,
  type AgentModel,
  type ModelPickerTab,
} from "../lib/models";
import {
  harnessUnavailableHint,
  hasProbedHarnessAvailability,
  isHarnessAvailable,
  probeHarnessAvailability,
  subscribeHarnessAvailability,
  getHarnessAvailabilitySnapshot,
} from "../lib/harness/availability";
import { refreshHarnessCatalogs } from "../lib/harness/registry";
import { refreshCatalog } from "../lib/tcserver/catalog";
import { registry } from "../lib/connection";
import { useAccounts } from "../stores/accounts";
import {
  HARNESSES,
  HARNESS_LABEL,
  HARNESS_TITLE,
  type HarnessId,
} from "../lib/session";
import { HarnessIcon } from "./HarnessIcon";
import { OPEN_MODEL_PICKER, type ModelPick, type ModelPickerRequest } from "../lib/modelPickerSignal";
import { effortLabel, ModelSettingsRows, useModelSettings } from "./ModelSettings";
import type { ModelRows } from "./ModelRows";
import { menuChunk } from "../surfaces/chunks";

type Props = {
  harness: HarnessId;
  model: string;
  /** The host whose catalog and CLIs the list shows; this machine when absent. */
  environmentId?: string;
  hotkeys?: boolean;
  onChange: (harness: HarnessId, model: string) => void;
  onClose?: () => void;
  /** The model's settings, edited at the menu's foot; absent shows the list alone. */
  settings?: {
    values: Record<string, string>;
    onChange: (settings: Record<string, string>) => void;
  };
  /** The composer's row under the box: 24px, 12px muted (`ROW_CONTROL`). */
  quiet?: boolean;
  /** Only these providers, in tabs, favorites and search (a Work thread's: src/shared/work/providers.ts); every one when absent. */
  providers?: readonly HarnessId[];
};

/** Search ladder across every provider: name prefix, name substring, then
 *  "provider name" substring; null is no match. */
export function matchRank(query: string, name: string, providerLabel: string): number | null {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  if (`${providerLabel} ${name}`.toLowerCase().includes(q)) return 3;
  return null;
}

export function ModelPicker({
  harness,
  model,
  environmentId,
  hotkeys = false,
  onChange,
  onClose,
  settings,
  quiet = false,
  providers,
}: Props) {
  const catalogVersion = useSyncExternalStore(
    subscribeModels,
    getModelSnapshot,
    getModelSnapshot,
  );
  const availabilityVersion = useSyncExternalStore(
    subscribeHarnessAvailability,
    getHarnessAvailabilitySnapshot,
    getHarnessAvailabilitySnapshot,
  );
  const visibilityVersion = useSyncExternalStore(
    subscribePickerVisibility,
    getPickerVisibilitySnapshot,
    getPickerVisibilitySnapshot,
  );
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ModelPickerTab>(() => loadModelPickerTab());
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState(loadFavoriteModels);
  const search = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const current = resolveModel(harness, model, environmentId);
  const shown = triggerName(current);
  const modelSettings = useModelSettings(harness, model, environmentId);
  const effort = settings ? effortLabel(modelSettings, settings.values) : null;
  const tabRef = useRef(tab);
  const openRef = useRef(open);
  const lastHotkey = useRef(0);
  const searchRef = useRef(false);

  const available = (id: HarnessId) => isHarnessAvailable(id, environmentId);
  const shownInPicker = (id: HarnessId) =>
    (!providers || providers.includes(id)) &&
    showProviderInModelPicker(
      id,
      available(id),
      hasProbedHarnessAvailability(environmentId),
    );
  // A remote host's lists come over its own link; this machine's through its adapters.
  const remote = environmentId !== undefined && environmentId !== registry.primaryEnvironmentId;
  const refreshLists = (ids: HarnessId[]) =>
    remote ? refreshCatalog(environmentId).catch(() => undefined) : refreshHarnessCatalogs(ids);
  const pickerHarnesses = HARNESSES.filter(shownInPicker);
  const visibleTab = coerceModelPickerTab(tab, shownInPicker);
  if (visibleTab !== tab) {
    setTab(visibleTab);
  }
  tabRef.current = visibleTab;
  openRef.current = open;

  // A pick (or the hotkey closing it) hands focus back to the field through
  // onClose; Escape and an outside press return it to the trigger.
  const toField = useRef(false);
  const dismiss = (restore: boolean) => {
    toField.current = restore && !!onCloseRef.current;
    setOpen(false);
    if (toField.current) onCloseRef.current?.();
  };

  // The request that opened the picker, until it closes: its onPick runs once, after a pick.
  const requested = useRef<((pick: ModelPick) => void) | null>(null);

  const openPicker = (onPick: ((pick: ModelPick) => void) | null = null) => {
    toField.current = false;
    requested.current = onPick;
    setOpen(true);
  };

  // The failure card's "Continue on another model" opens the active composer's picker.
  useEffect(() => {
    if (!hotkeys) return;
    const onRequest = (event: Event) => openPicker((event as CustomEvent<ModelPickerRequest>).detail?.onPick ?? null);
    window.addEventListener(OPEN_MODEL_PICKER, onRequest);
    return () => window.removeEventListener(OPEN_MODEL_PICKER, onRequest);
  }, [hotkeys]);

  const togglePicker = () => {
    if (openRef.current) dismiss(true);
    else openPicker();
  };

  const toggleFromHotkey = () => {
    const now = performance.now();
    if (now - lastHotkey.current < 80) return;
    lastHotkey.current = now;
    togglePicker();
  };

  const selectTab = (next: ModelPickerTab) => {
    setTab(next);
    saveModelPickerTab(next);
  };

  useEffect(() => {
    if (!open) return;
    void probeHarnessAvailability({ environmentId });
    setTab(coerceModelPickerTab(loadModelPickerTab(), shownInPicker));
    setQuery("");
  }, [open]);

  const searching = query.trim().length > 0;

  useEffect(() => {
    if (!open) return;
    if (searching) {
      void refreshLists(pickerHarnesses);
      return;
    }
    if (visibleTab === "favorites") return;
    void refreshLists([visibleTab]);
    // pickerHarnesses is derived from the availability snapshot below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, visibleTab, searching, availabilityVersion]);

  useEffect(() => {
    const inBlockingUi = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      if (target.closest(".docket-terminal")) return true;
      return Boolean(
        target.closest(
          "[data-file-picker], [data-branch-picker], [data-command-popover], [data-access-picker], [data-add-menu], [data-slot=select-content]",
        ),
      );
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const mod = modOrCtrl(e);
      if (
        hotkeys &&
        mod &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "." || e.code === "Period")
      ) {
        if (!openRef.current && inBlockingUi(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        toggleFromHotkey();
        return;
      }
      if (!openRef.current) return;
      if (e.altKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (inBlockingUi(e.target)) return;
      // Search spans every provider, so there is no tab to step.
      if (searchRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      selectTab(
        stepModelPickerTab(
          tabRef.current,
          e.key === "ArrowLeft" ? -1 : 1,
          shownInPicker,
        ),
      );
    };

    const onMenu = () => {
      if (!hotkeys) return;
      if (inBlockingUi(document.activeElement)) return;
      toggleFromHotkey();
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("open_model_picker", onMenu);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("open_model_picker", onMenu);
    };
  }, [hotkeys]);

  searchRef.current = searching;

  // A maker's rows inside a harness (Meta's under Claude and Codex) ride an
  // API key: with none on the thread's host they are left out, so the tabs
  // show only what a send could reach (a Meta model over the subscription is
  // the Muse harness's own row).
  const { snapshot } = useAccounts(environmentId ?? registry.primaryEnvironmentId);
  const keyed = snapshot.providers.meta?.profiles.length > 0;
  const reachable = (item: AgentModel) => shownInPicker(item.harness) && (keyed || !item.vendor);
  const visible = useMemo(() => {
    const needle = query.trim();
    if (!needle) {
      return visibleTab === "favorites"
        ? favorites
            .map((id) => findModel(id))
            .filter(
              (item): item is AgentModel =>
                item != null && reachable(item),
            )
        : tabModels(visibleTab, environmentId).filter(reachable);
    }
    // Typing searches every shown provider: rank ladder, favorites first
    // within a rank, catalog order last.
    return allModels(environmentId)
      .filter(reachable)
      .flatMap((item, order) => {
        const rank = matchRank(
          needle,
          item.name,
          `${HARNESS_TITLE[item.harness]} ${HARNESS_LABEL[item.harness]}`,
        );
        if (rank == null) return [];
        return [{ item, rank: rank * 2 + (favorites.includes(item.id) ? 0 : 1), order }];
      })
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map((row) => row.item);
    // Catalog, install probes, and picker-visibility all feed this list:
    // catalogs land after mount, and hiding a provider must drop its favorites.
  }, [
    visibleTab,
    query,
    favorites,
    environmentId,
    keyed,
    catalogVersion,
    availabilityVersion,
    visibilityVersion,
  ]);

  const pick = (item: AgentModel) => {
    if (!available(item.harness)) return;
    onChange(item.harness, item.id);
    const onPick = requested.current;
    requested.current = null;
    dismiss(true);
    onPick?.({ harness: item.harness, model: item.id, settings: mergeModelSettings(item, settings?.values) });
  };

  const toggleFavorite = (id: string) => {
    setFavorites((prev) => {
      const next = prev.includes(id)
        ? prev.filter((item) => item !== id)
        : [...prev, id];
      saveFavoriteModels(next);
      return next;
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) openPicker();
        else dismiss(false);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label={triggerLabel(current, effort)}
                  aria-keyshortcuts={keyHint("mod+.")}
                  size={quiet ? "xs" : "sm"}
                  // One recipe in every placement (ModelMark's): the logo 6px from the name,
                  // the effort 4px after it, the chevron 8px after the last word. Each gap is
                  // the following element's margin, so a word the composer hides takes its gap with it.
                  className={cn("min-w-0 shrink gap-0 px-2 font-normal", quiet && ROW_CONTROL)}
                />
              }
            />
          }
        >
          <HarnessIcon harness={current.harness} className="size-3.5 shrink-0" />
          {/* In the composer's row the words give way to the icon as the box narrows (ComposerBar). */}
          <span className={cn("ms-1.5 min-w-0 truncate @max-[9rem]/composer-bar:hidden", quiet ? "font-medium" : "text-foreground")}>{shown}</span>
          {effort ? <span className={cn("ms-1 shrink-0 @max-[23rem]/composer-bar:hidden", !quiet && "text-muted-foreground")}>{effort}</span> : null}
          <ChevronDown className="ms-2 size-3 shrink-0 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent>
          Model <Kbd>{keyHint("mod+.")}</Kbd>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        initialFocus={search}
        finalFocus={() => !toField.current}
        aria-label="Model picker"
        data-model-picker
        className="w-80 gap-0 p-1"
      >
        {searching ? null : (
          <ToggleGroup
            spacing={0}
            size="sm"
            aria-label="Providers"
            value={[visibleTab]}
            onValueChange={(next: unknown[]) => {
              const tab = next[0] as ModelPickerTab | undefined;
              if (tab) selectTab(tab);
            }}
            className="mb-1 w-full"
          >
            <ProviderToggle value="favorites" title="Favorites">
              <Star fill={visibleTab === "favorites" ? "currentColor" : "none"} />
            </ProviderToggle>
            {pickerHarnesses.map((id) => (
              <ProviderToggle key={id} value={id} title={HARNESS_TITLE[id]}>
                <HarnessIcon harness={id} className="size-3.5" />
              </ProviderToggle>
            ))}
          </ToggleGroup>
        )}
        {/* The popover's content mounts only once the menu chunk has landed; the field and the list ride it. */}
        <RowsOf
          search={search}
          query={query}
          onQuery={setQuery}
          available={available}
          harnessTitle={harnessTitleOf}
          unavailableHint={harnessUnavailableHint}
          models={visible}
          currentId={current.id}
          favorites={favorites}
          grouped={!searching && visibleTab !== "favorites"}
          emptyLabel={
            searching
              ? "No matching models"
              : visibleTab === "favorites"
                ? "No favorite models"
                : !available(visibleTab)
                  ? harnessUnavailableHint(visibleTab, environmentId)
                  : visibleTab === "codex"
                    ? "Loading Codex models…"
                    : "No matching models"
          }
          onPick={pick}
          onToggleFavorite={toggleFavorite}
        />
        {settings && modelSettings.length > 0 ? (
          <>
            <Separator className="my-1" />
            <ModelSettingsRows
              harness={harness}
              model={model}
              environmentId={environmentId}
              values={settings.values}
              onChange={settings.onChange}
            />
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The name the trigger shows beside its harness's mark: the mark already
 *  says Claude, so a Claude model drops the maker ("Opus 5.5"), as ModelMark does. */
export function triggerName(item: Pick<AgentModel, "harness" | "name">): string {
  return item.harness === "claude" ? item.name.replace(/^Claude\s+/, "") : item.name;
}

/** The trigger's accessible name, the uncut form: "Claude Opus 5.5, High effort";
 *  any other model names its harness ("GPT-5.5 on Codex", "Muse Wonder 1.0 on Claude Code"). */
export function triggerLabel(item: Pick<AgentModel, "harness" | "name" | "vendor">, effort: string | null): string {
  const name =
    item.harness === "claude" && !item.vendor
      ? /^Claude\s/.test(item.name) ? item.name : `Claude ${item.name}`
      : `${item.name} on ${HARNESS_TITLE[item.harness]}`;
  return effort ? `${name}, ${effort} effort` : name;
}

function ProviderToggle({ value, title, children }: { value: ModelPickerTab; title: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<ToggleGroupItem value={value} aria-label={title} className="flex-1" />}>{children}</TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

/** A harness tab's rows. Before its live catalog lands a tab whose built-in
 *  list is only a maker's rows (Codex) reads as loading, not as that list. */
function tabModels(harness: HarnessId, environmentId?: string): AgentModel[] {
  const models = ownThenVendor(modelsFor(harness, environmentId));
  return models.every((m) => m.vendor) && !hasLiveCatalog(harness, environmentId) ? [] : models;
}

/** A harness tab lists its own rows first, then a maker's (catalog `vendor`). */
function ownThenVendor(models: AgentModel[]): AgentModel[] {
  return models.some((m) => m.vendor) ? [...models.filter((m) => !m.vendor), ...models.filter((m) => m.vendor)] : models;
}

const harnessTitleOf = (id: HarnessId): string => HARNESS_TITLE[id];

/** The open body, from the menu chunk the open popover already loaded (chrome/ModelRows.tsx). */
function RowsOf(props: Parameters<typeof ModelRows>[0]) {
  const Body = menuChunk.loaded();
  return Body ? <Body.ModelRows {...props} /> : null;
}
