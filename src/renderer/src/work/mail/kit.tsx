import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MailClient, MailFaceProps, MailKit, MailSectorMarkProps, MailToastInput, MailWrite, OutboxActions } from "work-kit/mail";
import { createLifeosMailClient } from "work-kit/lifeos";
import type { MailSendAnswer } from "@shared/contract-work-mail";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { loadToast } from "../../components/ui/toaster";
import { useColorScheme } from "../../hooks/useColorScheme";
import { cn } from "../../lib/cn";
import { registry } from "../../lib/connection";
import { keyHint, modOrCtrl } from "../../lib/keys";
import { openUrl } from "../../lib/native";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";

/**
 * TempCode's side of the shared mail client (work-kit/mail README, "The
 * two seams"): LifeOS's `MailClient` with Send taken through the host, and a
 * `MailKit` of TempCode's own look and manners. One of each per host and
 * LifeOS address, kept for the window's life, since the screens call their
 * hooks in a fixed order.
 */

/** The composer's Send: the draft is saved as he sees it, then the host sends it (`work.mail.send`), never this window. */
export function sendThroughHost(env: string, actions: OutboxActions): OutboxActions {
  return {
    ...actions,
    send: async (args) => {
      const id = await actions.save(args);
      await registry.linkOf(env).request<MailSendAnswer>("work.mail.send", { id, ...(args.sendAt !== undefined ? { sendAt: args.sendAt } : {}) });
      return id;
    },
  };
}

/** Every write a screen makes: its toast on success, with Undo where it has one, and its own words on failure. */
const write: MailWrite = async ({ run, failed, message, undo }) => {
  try {
    const result = await run();
    if (message) {
      void loadToast().then((toast) =>
        toast(message, undo ? { action: { label: "Undo", onClick: () => void undo(result).catch(() => toast.error("Undo did not go through")) } } : undefined),
      );
    }
    return result;
  } catch {
    void loadToast().then((toast) => toast.error(failed));
    return undefined;
  }
};

function wrapClient(env: string, inner: MailClient): MailClient {
  return {
    ...inner,
    useOutboxActions() {
      const actions = inner.useOutboxActions();
      return useMemo(() => sendThroughHost(env, actions), [actions]);
    },
  };
}

const clients = new Map<string, MailClient>();

/** The mail client for a host's LifeOS at `convexUrl`: made once, then the same object every time. */
export function mailClientFor(env: string, convexUrl: string): MailClient {
  const key = `${env}|${convexUrl}`;
  let client = clients.get(key);
  if (!client) {
    client = wrapClient(env, createLifeosMailClient({ convexUrl, write }));
    clients.set(key, client);
  }
  return client;
}

// ── the kit ────────────────────────────────────────────────────────────

const toast = (input: string | MailToastInput): void => {
  const t = typeof input === "string" ? { message: input } : input;
  void loadToast().then((api) => {
    const options = {
      ...(t.id ? { id: t.id } : {}),
      ...(t.action ? { action: { label: t.action.label, onClick: t.action.run } } : {}),
      ...(t.lifetime !== undefined ? { duration: t.lifetime ?? Number.POSITIVE_INFINITY } : {}),
    };
    if (t.state === "error") api.error(t.message, options);
    else api(t.message, options);
  });
};

const initials = (name: string | undefined): string =>
  (name ?? "")
    .replace(/<[^>]*>|["']/g, "")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/** A person as initials on `muted` in a circle (docs/DESIGN.md, avatars): 16px beside a row's senders, 24px in a header. */
function Face({ name, size = "row", className }: MailFaceProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full bg-muted font-semibold text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline)",
        size === "line" ? "size-4 text-[7px]" : "size-6 text-[9px]",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

const SECTOR_NAMES: Record<string, string> = { cosmic: "Cosmic", hypixel: "Hypixel", purdue: "Purdue", ref: "Ref", unify: "Unify", life: "Life" };

function SectorMark({ sector, label = true, className }: MailSectorMarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
      <SectorDot sector={sector} />
      {label ? SECTOR_NAMES[sector] ?? sector : null}
    </span>
  );
}

function useToday(): number {
  const midnight = (): number => new Date().setHours(0, 0, 0, 0);
  const [today, setToday] = useState(midnight);
  useEffect(() => {
    const next = new Date(today);
    next.setDate(next.getDate() + 1);
    const timer = window.setTimeout(() => setToday(midnight()), next.getTime() - Date.now() + 50);
    return () => window.clearTimeout(timer);
  }, [today]);
  return today;
}

/** Keys on the page, never while typing or while a dialog or menu is open. */
function useKey(handler: (event: KeyboardEvent) => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || modOrCtrl(event) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
      if (document.querySelector("[role='dialog'], [role='menu'], [role='listbox']")) return;
      handler(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handler, enabled]);
}

const opened = async (file: { url: string }): Promise<"opened"> => {
  await openUrl(file.url);
  return "opened";
};

class Boundary extends Component<{ className?: string; onNotFound?: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    if (/not found|does not exist/i.test(String(error))) this.props.onNotFound?.();
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={this.props.className}>
        <EmptyState title="This mail could not be shown" />
      </div>
    );
  }
}

export const tempcodeMailKit: MailKit = {
  toast,
  Face,
  SectorMark,
  keyHint: (chord) => keyHint(chord),
  useDark: () => useColorScheme() === "dark",
  useToday,
  useKey,
  onFrameKey: () => () => {},
  onMailto: () => () => {},
  openFile: opened,
  saveFile: opened,
  fetchImage: async (url) => (await fetch(url)).blob(),
  Boundary,
};
