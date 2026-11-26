import { useSyncExternalStore } from "react";
import { registry } from "../lib/connection";
import { getHarnessAvailabilitySnapshot, hasProbedHarnessAvailability, harnessUnavailableHint, isHarnessAvailable, subscribeHarnessAvailability } from "../lib/harness/availability";
import { capsAllowFullAccess, linkMay, sendElsewhere } from "../lib/linkMayCore";
import { PICKER_RUNTIME_MODES, type HarnessId, type RuntimeMode } from "../lib/session";
import { modeForPolicy } from "../lib/tcserver/access";

/**
 * What the composer may offer on its host (D5, docs/DESIGN.md "Loading and empty states": no control the host would
 * only refuse). A key that may not send gets no live Send and the field says who can (composer-03); a host that has
 * answered it has no CLI for the harness holds Send with the model menu's words (composer-16); the permission select
 * offers only the modes the key may give, and is not drawn on a thread whose mode it may not change (composer-04);
 * Compact is offered only to a key that may compact.
 */
export type ComposerAsks = { refusal: string | null; accessModes: readonly RuntimeMode[] | null; mayCompact: boolean };

const subscribeLink = (listener: () => void) => registry.subscribe(listener);

/** One primitive per answer set, so a status change that moves none of them renders nothing. */
function askKey(environmentId: string, harness: HarnessId, draft: boolean): string {
  const send = linkMay(environmentId, draft ? "session.create" : "session.send");
  // A new thread carries its mode in session.create, held to the key's ceiling (`accessCeiling`, the host's own rule).
  const hello = registry.statusOf(environmentId).lastHello;
  const capped = !!hello?.key && !capsAllowFullAccess(hello.caps);
  const modes = draft
    ? !send ? [] : capped ? PICKER_RUNTIME_MODES.filter((mode) => mode !== modeForPolicy("auto")) : PICKER_RUNTIME_MODES
    : linkMay(environmentId, "session.permission") ? PICKER_RUNTIME_MODES : [];
  const compact = linkMay(environmentId, "session.compact");
  const missing = hasProbedHarnessAvailability(environmentId) && !isHarnessAvailable(harness, environmentId);
  return `${send ? 1 : 0}|${modes.join(",")}|${compact ? 1 : 0}|${missing ? 1 : 0}`;
}

export function useComposerAsks(environmentId: string, harness: HarnessId, draft: boolean): ComposerAsks {
  useSyncExternalStore(subscribeHarnessAvailability, getHarnessAvailabilitySnapshot);
  const key = useSyncExternalStore(subscribeLink, () => askKey(environmentId, harness, draft));
  const [send, modes, compact, missing] = key.split("|");
  const name = registry.environment(environmentId)?.name ?? environmentId;
  const shown = modes ? (modes.split(",") as RuntimeMode[]) : [];
  return {
    refusal: send === "0" ? sendElsewhere(name) : missing === "1" ? harnessUnavailableHint(harness, environmentId) : null,
    accessModes: shown.length === 0 ? null : shown.length === PICKER_RUNTIME_MODES.length ? PICKER_RUNTIME_MODES : shown,
    mayCompact: compact === "1",
  };
}
