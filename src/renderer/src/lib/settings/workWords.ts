import { hostFailure } from "../hostFailure";

/**
 * A Work setting's change, its refusal put in his words before the row's red line says it (`useSaved` shows a refusal's
 * own text): `workErrorWords` for a known fault, else "<The computer> did not save the change.", the computer named.
 * Never a method, a path or the link's own text.
 */
export async function inWords<T>(environmentId: string, change: () => Promise<T>): Promise<T> {
  try {
    return await change();
  } catch (err) {
    throw new Error(hostFailure(environmentId, err, "did not save the change", true));
  }
}
