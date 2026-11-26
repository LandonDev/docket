import type { SavedEnvironment } from "@server/shared/contract-remote";
import { AddComputerDialog } from "../../computers/AddComputer";

/** The old page's Add… for a computer's sign-ins: the device way of Add a computer…, on `host` where it names one. */
export function PairDialog({ host, onClose, onChanged }: { host?: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> }) {
  return <AddComputerDialog ask={{ way: "device", computer: host?.id }} onClose={onClose} onChanged={() => void onChanged()} />;
}
