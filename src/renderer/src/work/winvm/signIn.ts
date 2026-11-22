import type { VmSignInAnswer } from "@shared/contract-work-office";
import { registry } from "../../lib/connection";
import { requestStage } from "../../lib/popOut";
import { shell } from "../../stores/shell";

/** The Windows VM's name on the Computers page (lib/computers.ts `ComputerTile.computer`). */
export const VM_COMPUTER = "vm:windows";
/** The VM may wake first: OneDrive's sign-in can take half a minute to come up. */
const SIGN_IN_MS = 120_000;

/** The Computers page with the Windows VM on its stage; opening it there wakes it and offers Take over. */
export function openVm(env: string): void {
  requestStage({ host: env, threadId: VM_COMPUTER });
  shell.openComputers();
}

/**
 * OneDrive's sign-in brought up on the Windows VM kept by `env` (`work.office.vmSignIn`), then the Computers page on
 * the VM, where he finishes it in a Take over. Throws the host's refusal for the press to show.
 */
export async function signInOnVm(env: string): Promise<VmSignInAnswer> {
  const answer = await registry.linkOf(env).request<VmSignInAnswer>("work.office.vmSignIn", {}, { timeoutMs: SIGN_IN_MS, lane: "ui" });
  openVm(env);
  return answer;
}
