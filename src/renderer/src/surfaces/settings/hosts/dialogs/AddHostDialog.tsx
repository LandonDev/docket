import type { SavedEnvironment } from "@server/shared/contract-remote";
import { AddComputerDialog } from "../../computers/AddComputer";

/** The old page's link to another computer: the link way of Add a computer…, signing in to `repair` again where it names one. */
export function AddHostDialog({ repair, onClose, onChanged }: { repair?: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> }) {
  return <AddComputerDialog ask={{ way: "link", computer: repair?.id }} onClose={onClose} onChanged={() => void onChanged()} />;
}
