import type { MacBridgePolicy } from "@shared/contract-macbridge";
import { LOCAL_ENVIRONMENT_ID } from "../connection";
import { thisDesktopName } from "../native";
import { computerNameOf, type ComputerName, type ComputerNames } from "./computerName";

/**
 * A job's "Computers its threads may use" (docs/agents/settings.md "The pages: jobs, workspaces, Archive"): one row per
 * desktop, each by its one name, and where the job allows a computer that itself refuses the job's computer, the words
 * that say so.
 */

/** A desktop row as the job page lists it: the id this window's link has for it ("local" for its own), its host id,
 *  and the name whoever listed it gave. */
export type JobDesktop = { link: string; host: string; name: string };

/** A job row's computer, the same name in every window: this window's own by its link, any other by its host id. */
export const jobDesktopName = (desktop: JobDesktop, names: (id: string, said?: string | null) => ComputerName): ComputerName =>
  names(desktop.link === LOCAL_ENVIRONMENT_ID ? LOCAL_ENVIRONMENT_ID : desktop.host, desktop.name);

/** The same, from a window's names in hand (a test's three windows). */
export const jobDesktopNameIn = (desktop: JobDesktop, known: ComputerNames): ComputerName => jobDesktopName(desktop, (id, said) => computerNameOf(id, known, said));

/** One computer's bridge policy for the hosts it serves, as its window or its activity read gives it. */
export type BridgePolicy = { environmentId: string; policy: MacBridgePolicy };

/** Whether a computer whose bridge policies are `policies` refuses the job's computer: its Files and commands for it
 *  are Off. A computer that never listed the job's computer, or whose policies this window cannot read, refuses nothing
 *  this page can say. */
export const refusesJob = (policies: readonly BridgePolicy[] | null | undefined, jobHost: string): boolean =>
  !!policies?.some((entry) => entry.environmentId === jobHost && entry.policy === "off");

/** The amber line under a refusing computer's row: which machine refuses and where it changes. This Mac's own goes to
 *  Sharing here (the row's press); another's is changed on that machine, so the line says where. */
export function refusalWords(computer: ComputerName, jobComputer: string): string {
  if (computer.own) return `${thisDesktopName()} gives ${jobComputer} no access.`;
  return `${computer.name} gives ${jobComputer} no access. Change it on ${computer.name}, under Sharing.`;
}
