import { registry } from "./connection";
import { nameInLine } from "./hostWords";
import { workErrorWords } from "./workErrorWords";

/**
 * A failed act on a Work host in his words, naming the computer: `workErrorWords` for a known fault, else the act's
 * own sentence ("The box did not wake the Windows VM."), never the link's text. `act` follows the host's name.
 */
export function hostFailure(env: string, err: unknown, act: string, write = false): string {
  const name = registry.environment(env)?.name;
  const host = name ? nameInLine(name) : undefined;
  const Host = host ? host.charAt(0).toUpperCase() + host.slice(1) : "The computer";
  return workErrorWords(err, { host, write }) || `${Host} ${act}.`;
}
