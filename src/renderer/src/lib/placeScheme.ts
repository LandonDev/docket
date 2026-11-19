import { projectStore } from "../stores/project";
import {
  isLightScheme,
  isThemeKey,
  loadPlaceKind,
  loadThemePreference,
  resolveColorScheme,
  savePlaceKind,
  SCHEME_CHANGE_EVENT,
  systemQuery,
  type ColorScheme,
  type PlaceKind,
} from "./appearance";
import { WORK_CHATS, workspaceByPath, workspaceStore, type WorkspaceCatalog } from "./tcserver/workspaces";

/**
 * A window wears the theme of the place selected in its rail
 * (docs/DESIGN.md "Appearance by place"): a code workspace and Chats take
 * Code's theme, a Work workspace and Work Chats take Work's. A page opened
 * over a place (Settings, Inbox, Outbox, Search) moves no place, so it
 * changes nothing here. First-paint code: it knows a Work workspace only by
 * the `kind` on its row.
 */

/** The kind of the place at `projectCwd`, or null while the catalog cannot
 *  say yet: the window then keeps the theme it wears. */
export function placeKind(projectCwd: string, catalog: Pick<WorkspaceCatalog, "loaded" | "workspaces">): PlaceKind | null {
  if (projectCwd === WORK_CHATS) return "work";
  if (projectCwd === "~") return "code";
  const workspace = workspaceByPath(catalog.workspaces, projectCwd);
  if (workspace) return workspace.kind === "work" ? "work" : "code";
  // A folder no row names is a code folder, once every row has arrived.
  return catalog.loaded ? "code" : null;
}

let kind: PlaceKind = "code";
/** The theme the last change asked for: what every flip sets, so one that runs late (a skipped dissolve's) cannot undo a newer one. */
let wanted: ColorScheme | null = null;
let dissolve: { skipTransition(): void } | null = null;

/** The kind of place this window is on. */
export const currentPlaceKind = (): PlaceKind => kind;

const reducedMotion = (): boolean => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Main keeps the window's theme and kind with its geometry: the next launch
 *  opens with that backing colour and that class (src/main/windows.ts). The
 *  web /ui has no main to tell. */
function tellMain(scheme: ColorScheme): void {
  (window as { api?: { win?: { setAppearance?: (appearance: { scheme: ColorScheme; kind: PlaceKind }) => void } } }).api?.win?.setAppearance?.({ scheme, kind });
}

/**
 * The one function that sets the theme's class. Where the theme differs it
 * dissolves in: the class changes inside a view transition, so the window's
 * last picture fades into the new theme over `--dur-fast` (index.css), with
 * element transitions off while it runs, since a colour animating on its own
 * smears. With no view transitions, in a hidden window, under reduced motion
 * or when `instant`, the class is set at once. A second change during a
 * dissolve skips the first. The class is right whatever the dissolve does.
 */
export function changeScheme(next: ColorScheme, instant = false): void {
  tellMain(next);
  wanted = next;
  // A dissolve under way has yet to set its class: it will set this one instead.
  if (!dissolve && isLightScheme() === (next === "light")) return;
  const root = document.documentElement;
  const flip = (): void => {
    const light = wanted === "light";
    if (root.classList.contains("theme-light") === light) return;
    root.classList.toggle("theme-light", light);
    window.dispatchEvent(new CustomEvent<ColorScheme>(SCHEME_CHANGE_EVENT, { detail: light ? "light" : "dark" }));
  };
  dissolve?.skipTransition();
  dissolve = null;
  root.classList.add("theme-switching");
  const start = instant || document.hidden || reducedMotion() ? undefined : document.startViewTransition?.bind(document);
  if (start) {
    try {
      const transition = start(flip);
      dissolve = transition;
      const done = (): void => {
        // A later change owns the class by now if this one was skipped.
        if (dissolve !== transition) return;
        dissolve = null;
        flip();
        root.classList.remove("theme-switching");
      };
      transition.finished.then(done, done);
      return;
    } catch {
      // The page refused a transition: the plain flip below.
    }
  }
  flip();
  // One forced style read, so the swap lands with element transitions off; they are back next frame.
  void getComputedStyle(root).opacity;
  requestAnimationFrame(() => {
    if (!dissolve) root.classList.remove("theme-switching");
  });
}

/** Wear the theme chosen for the place the window is on: after a setting
 *  changes, here or in another window, or the system turns over. */
export function applyPlaceScheme(instant = false): void {
  changeScheme(resolveColorScheme(loadThemePreference(kind)), instant);
}

function moveTo(next: PlaceKind): void {
  if (next === kind) return;
  kind = next;
  savePlaceKind(next);
  applyPlaceScheme();
}

/** Follow the rail: the project store names the place, the workspace catalog
 *  its kind, and either can be the late one. The stores call back before
 *  React commits, so a place and its theme land in one frame. */
export function watchPlace(): () => void {
  const follow = (): void => {
    const next = placeKind(projectStore.getState().projectCwd, workspaceStore.getSnapshot());
    if (next) moveTo(next);
  };
  const offProject = projectStore.subscribe(follow);
  const offCatalog = workspaceStore.subscribe(follow);
  follow();
  return () => {
    offProject();
    offCatalog();
  };
}

/** At launch: the kind boot.js read, its theme (already on the page, so
 *  nothing moves), then the rail, the system's setting and other windows'
 *  changes to a setting. */
export function initPlaceScheme(): () => void {
  kind = loadPlaceKind();
  const next = resolveColorScheme(loadThemePreference(kind));
  // What is mounted already hears the theme once, as it always has, whether or not the class moves.
  if (isLightScheme() === (next === "light")) window.dispatchEvent(new CustomEvent<ColorScheme>(SCHEME_CHANGE_EVENT, { detail: next }));
  changeScheme(next, true);
  const offPlace = watchPlace();
  const onSystem = (): void => applyPlaceScheme();
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || isThemeKey(event.key)) applyPlaceScheme();
  };
  const query = systemQuery();
  query?.addEventListener("change", onSystem);
  window.addEventListener("storage", onStorage);
  return () => {
    offPlace();
    query?.removeEventListener("change", onSystem);
    window.removeEventListener("storage", onStorage);
    dissolve = null;
  };
}
