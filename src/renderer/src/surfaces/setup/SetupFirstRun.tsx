import { useEffect, useRef, useState } from "react";
import type { SetupState } from "@server/shared/contract-devices";
import { registry, LOCAL_ENVIRONMENT_ID } from "../../lib/connection";
import { readSetupState } from "../../lib/devicesClient";
import { isWebMode } from "../../lib/nativeWeb";
import { useWorkspaceCatalog } from "../../lib/tcserver/workspaces";
import { useAccounts } from "../../stores/accounts";
import { setupChunk } from "../chunks";
import { allDone } from "../settings/hosts/computersText";
import { isFreshInstall, SETUP_OFFERED_KEY } from "./setupFlow";

const UseSetupLinkDialog = setupChunk.surface("UseSetupLinkDialog");

const offered = (): boolean => {
  try {
    return localStorage.getItem(SETUP_OFFERED_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * The first screen of a fresh install (no saved hosts, no workspaces, no
 * accounts): Paste the setup link, once; and a setup under way opens
 * on its steps at every launch until it is done. Decided once a launch, from
 * the three counts and `devices.setup.state`.
 */
export function SetupFirstRun() {
  const catalog = useWorkspaceCatalog();
  const accounts = useAccounts(LOCAL_ENVIRONMENT_ID);
  const [saved, setSaved] = useState<number | null>(null);
  const [under, setUnder] = useState<SetupState | null | undefined>(undefined);
  const [open, setOpen] = useState<null | { steps: SetupState | null }>(null);
  const decided = useRef(false);
  const web = isWebMode();

  useEffect(() => {
    if (web) return;
    void registry
      .primary()
      .request<unknown[]>("remote.environments.list")
      .then((list) => setSaved(list.length), () => setSaved(null));
    // A host from before the setup link answers an error: no setup is under way there.
    void readSetupState().then(setUnder, () => setUnder(null));
  }, [web]);

  const profiles = accounts.loaded ? Object.values(accounts.snapshot.providers).reduce((n, p) => n + p.profiles.length, 0) : null;
  useEffect(() => {
    if (web || decided.current || under === undefined) return;
    if (under && !under.done && !allDone(under.steps)) {
      decided.current = true;
      setOpen({ steps: under });
      return;
    }
    if (offered()) {
      decided.current = true;
      return;
    }
    if (isFreshInstall({ savedHosts: saved, workspaces: catalog.loaded ? catalog.workspaces.length : null, accounts: profiles })) {
      decided.current = true;
      setOpen({ steps: null });
    }
  }, [web, under, saved, catalog.loaded, catalog.workspaces.length, profiles]);

  if (!open) return null;
  return (
    <UseSetupLinkDialog
      first={!open.steps}
      phase={open.steps ? { at: "steps", state: open.steps } : undefined}
      onClose={() => {
        try {
          localStorage.setItem(SETUP_OFFERED_KEY, "1");
        } catch {
          // private mode
        }
        setOpen(null);
      }}
    />
  );
}
