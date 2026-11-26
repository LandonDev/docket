import { useEffect, useState } from "react";
import { ADD_COMPUTER_EVENT, openAddComputer, tellAddComputerChanged, type AddComputerAsk } from "../../../lib/settings/addComputer";
import { tellSettingsList } from "../../../lib/settings/useListWindow";
import { isWebMode } from "../../../lib/nativeWeb";
import { AddComputerDialog } from "./AddComputer";

/**
 * Where Add a computer… opens (docs/agents/settings.md "Add a computer"): mounted once by Settings, it hears each ask
 * (`openAddComputer`) and holds the one dialog, and gives the list its press for "Add a computer…" while it is
 * mounted. At /ui the list has no such row, so it gives none.
 */
export function AddComputerHost() {
  // Each ask opens a fresh dialog: the count keys it.
  const [open, setOpen] = useState<{ ask: AddComputerAsk; n: number } | null>(null);
  useEffect(() => {
    const onAsk = (event: Event): void => {
      const ask = (event as CustomEvent<AddComputerAsk | undefined>).detail ?? {};
      setOpen((prev) => ({ ask, n: (prev?.n ?? 0) + 1 }));
    };
    window.addEventListener(ADD_COMPUTER_EVENT, onAsk);
    const web = isWebMode();
    if (!web) tellSettingsList({ addComputer: pressAdd });
    return () => {
      window.removeEventListener(ADD_COMPUTER_EVENT, onAsk);
      if (!web) tellSettingsList({ addComputer: null });
    };
  }, []);
  return open ? <AddComputerDialog key={open.n} ask={open.ask} onClose={() => setOpen(null)} onChanged={tellAddComputerChanged} /> : null;
}

/** The list's press: the dialog at its first step. One function, so telling it twice changes nothing. */
const pressAdd = (): void => openAddComputer();
