import { attention as nativeAttention, bindServer, getServerPort, isWebMode } from "../native";
import { webSocketUrl } from "../nativeWeb";
import {
  LOCAL_ENVIRONMENT_ID,
  WEB_ENVIRONMENT_ID,
  localEnvironment,
  registry,
  savedEnvironment,
  webEnvironment,
  webEnvironmentNamed,
  trackLastSeen,
  type EnvLink,
} from "../connection";
import { smoke } from "./smoke";
import { focusSignal } from "./commands";
import { sessionStore } from "./store";
import { docketOpen } from "../docketOpen";
import { environmentStore } from "../../stores/environment";
import { forgetCatalog, probeDoctor, refreshCatalog } from "./catalog";
import { afterOpen } from "./openPhase";
import { dropHarnessModels, setDefaultCatalogEnvironment } from "../models";
import { dropHarnessAvailability, probeHarnessAvailability } from "../harness/availability";

type SavedEnvironmentRow = { id: string; name: string; routes: { url: string; kind: "loopback" | "lan" | "tunnel" }[]; keyId?: string; platform?: string };

declare global {
  interface Window {
    /** Devtools and the e2e scripts: the registry, the session store and the boot helpers. */
    __docket?: {
      registry: typeof registry;
      sessionStore: typeof sessionStore;
      /** The window's current environment and the workspace last used per environment (thread K2). */
      environment: typeof environmentStore;
      loadSavedEnvironments: typeof loadSavedEnvironments;
      smoke: typeof smoke;
      /** Opens a thread as a click would, beside the focused pane with `split` (lib/docketOpen.ts). */
      open: typeof docketOpen;
    };
  }
}

const TAG = "[docket:server]";

/**
 * Boot hook: register environment zero and start the connection runtime.
 * The desktop window asks preload for the loopback port and adds this
 * machine's server as `local`, exactly as the single client once connected;
 * the page served at /ui by the fixed port adds its own origin as `web`,
 * the cookie on the upgrade, and that is its only environment. Saved remote
 * hosts come from the main process once the local link is up.
 */
export function initServerLink(): void {
  if (typeof window !== "undefined") {
    window.__docket = { registry, sessionStore, environment: environmentStore, loadSavedEnvironments, smoke, open: docketOpen };
    registry.installWindowHooks();
    installFocusHooks();
    trackLastSeen();
  }
  // The bridge dispatches server commands over the environment's link.
  bindServer(registry);
  registry.onLink((link, event) => {
    if (event !== "added") {
      dropHarnessModels(link.environmentId);
      forgetCatalog(link.environmentId);
      dropHarnessAvailability(link.environmentId);
      return;
    }
    // A new socket holds no focus: tell it which thread this window shows.
    link.onOpen(() => focusSignal.reopened(link.environmentId));
    // Each host's model catalog, so a picker on its thread shows its rows; a new socket asks again whatever the 60 s.
    link.onOpen(() => void refreshCatalog(link.environmentId, { force: true }).catch(() => undefined));
    // Its providers' doctor after the first paint (openPhase.ts): one `doctor.get` answers the report and which
    // CLIs are installed (the pickers keep every provider until it has).
    link.onOpen(() =>
      afterOpen(link, () => Promise.all([report(link), probeHarnessAvailability({ environmentId: link.environmentId, force: true })])),
    );
    if (link.environmentId === LOCAL_ENVIRONMENT_ID) link.onOpen(() => void loadSavedEnvironments(link));
  });
  if (isWebMode()) {
    setDefaultCatalogEnvironment(WEB_ENVIRONMENT_ID);
    registry.setPrimary(WEB_ENVIRONMENT_ID);
    registry.add(webEnvironment(webSocketUrl(), location.hostname));
    // A refused cookie (expired, revoked) is sign-in again, never a retry loop.
    const off = registry.subscribe(() => {
      // The host's own name from its hello, in the address's place.
      const env = registry.environment(WEB_ENVIRONMENT_ID);
      const named = env && webEnvironmentNamed(env, registry.statusOf(WEB_ENVIRONMENT_ID).lastHello);
      if (named) registry.update(named);
      if (leaving || registry.statusOf(WEB_ENVIRONMENT_ID).transport !== "unauthorized") return;
      leaving = true;
      off();
      location.replace("/pair?signed-out");
    });
    return;
  }
  getServerPort().then(
    (port) => registry.add(localEnvironment(port)),
    (e) => console.error(`${TAG} no server port:`, e),
  );
}

/** The page is on its way to /pair; a second status change must not navigate again. */
let leaving = false;

/** The window losing focus clears this window's focus on every host; coming
 *  back restores it. Focus moving into a frame inside the window (an html
 *  render, a webview) blurs the window but leaves the document focused. */
function installFocusHooks(): void {
  focusSignal.window(document.hasFocus());
  // Away (locked, asleep, idle two minutes): no host is told a thread is on screen, so the phone still hears.
  void nativeAttention.present().then((present) => focusSignal.attention(present), () => undefined);
  nativeAttention.onChange((present) => focusSignal.attention(present));
  // A hidden document shows no thread: its rows may wait for the host's window.
  focusSignal.visible(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", () => focusSignal.visible(document.visibilityState === "visible"));
  window.addEventListener("focus", () => focusSignal.window(true));
  window.addEventListener("blur", () => {
    setTimeout(() => focusSignal.window(document.hasFocus()), 0);
  });
}

/** The hosts the main process keeps keys for join the registry (or update their routes). */
export async function loadSavedEnvironments(local: EnvLink = registry.linkOf(LOCAL_ENVIRONMENT_ID)): Promise<void> {
  try {
    const rows = await local.request<SavedEnvironmentRow[]>("remote.environments.list");
    const keep = new Set([LOCAL_ENVIRONMENT_ID]);
    for (const row of rows) {
      keep.add(row.id);
      registry.add(savedEnvironment(row));
    }
    for (const env of registry.environments()) if (!keep.has(env.id)) registry.remove(env.id);
  } catch (e) {
    console.error(`${TAG} saved environments:`, e);
  }
}

async function report(link: EnvLink): Promise<void> {
  try {
    const doctor = await probeDoctor(link.environmentId, { force: true });
    const providers = Object.entries(doctor)
      .map(([id, r]) => `${id} ${!r?.found ? "missing" : r.error ? "error" : "ok"}`)
      .join(", ");
    console.info(`${TAG} ${link.environmentId} connected ${link.transport?.url ?? ""}, providers: ${providers}`);
  } catch (e) {
    console.error(`${TAG} ${link.environmentId} handshake failed:`, e);
  }
}
