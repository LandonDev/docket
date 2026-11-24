import { ComputerAllowToasts } from "../../chrome/ComputerAllowToasts";
import { SetupFirstRun } from "./SetupFirstRun";

/**
 * The setup link's parts that live for the whole window (docs/agents/pc-setup.md
 * "The screens"): the giver's Allow notice and the computer's first screen. They
 * ride the `setupHost` chunk, mounted by App after the first paint; the entry
 * carries the chunk's port alone.
 */
export function SetupHost() {
  return (
    <>
      <ComputerAllowToasts />
      <SetupFirstRun />
    </>
  );
}
