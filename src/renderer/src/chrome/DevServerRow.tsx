import { useState } from "react";
import { useStore } from "zustand";
import { Tip } from "../components/tip";
import { BusyLabel, Button } from "../components/ui/button";
import { Item, ItemActions, ItemButton, ItemContent, ItemTitle } from "../components/ui/item";
import { ROW_CONTROLS, ROW_HOLDS, ROW_OPEN, ROW_SHOWS } from "../components/ui/press";
import { cn } from "../lib/cn";
import { registry } from "../lib/connection";
import { openUrl, portOpen } from "../lib/devPorts";
import { dialogErrorWords } from "../lib/dialogErrorWords";
import { DID_NOT_STOP, stopLiveServer, type LiveServer } from "../lib/devServers";
import { macBridgeStore } from "../lib/macBridge";
import { isWebMode } from "../lib/nativeWeb";
import { HostGlyph } from "./HostGlyph";

/** A failed Stop in a person's words: what failed, then why when the host said more than that it did not stop. */
function stopFailWords(err: unknown, environmentId: string): string {
  const why = dialogErrorWords(err, registry.environment(environmentId)?.name);
  return why && why !== DID_NOT_STOP ? `Couldn't stop the server. ${why}` : "Couldn't stop the server";
}

/**
 * One live dev server (docs/box.md "Dev servers on the box"), a row of the
 * Dev servers pane: what it is in plain words, its address on its host,
 * "Open on the Mac :5174" when it opens here, and Stop. The address is the
 * row's Open control (a local server's own address, else the Mac's link);
 * Stop is its one word button. `onPick` makes the row pick its console (the pane).
 */
export function DevServerRow({ server, picked = false, onPick }: { server: LiveServer; picked?: boolean; onPick?: () => void }) {
  const localId = useStore(macBridgeStore, (s) => s.localId);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = stopping || server.stopping !== undefined;
  const port = server.port;
  const open = port && !isWebMode() ? portOpen(port.number, port.environmentId, port.forwards, localId) : null;
  // A server on this machine opens from its own address; one elsewhere says where it lives, then where it opens here.
  const local = open?.label === "Open in browser";
  const stop = () => {
    setStopping(true);
    setError(null);
    void stopLiveServer(server)
      .catch((err: unknown) => setError(stopFailWords(err, server.environmentId)))
      .finally(() => setStopping(false));
  };
  const link = (text: string, url: string, name: string) => (
    <Button
      variant="link"
      size="xs"
      aria-label={name}
      className="pointer-events-auto h-auto px-0 text-xs font-normal tabular-nums text-muted-foreground hover:text-foreground"
      onClick={() => openUrl(url)}
    >
      {text}
    </Button>
  );
  // A row that picks its console is a container with its open control laid
  // over it (press.ts ROW_HOLDS): the address links and Stop are its own
  // buttons above it, never inside it.
  const picks = !!onPick;
  return (
    <Item
      size="xs"
      role="listitem"
      data-dev-server={server.key}
      className={cn("flex-nowrap rounded-md", picks && ROW_HOLDS, picked && "bg-muted hover:bg-muted")}
    >
      {picks ? <ItemButton data-row-open aria-label={server.title} aria-current={picked || undefined} onClick={onPick} className={ROW_OPEN} /> : null}
      <ItemContent className={cn("min-w-0 gap-0.5", picks && ROW_SHOWS)}>
        {/* The name wraps in its column, never cut (a narrow dock still reads it whole); Stop keeps its place. */}
        <ItemTitle className="line-clamp-none min-w-0 max-w-full">
          <span data-dev-server-title className="text-pretty break-words">{server.title}</span>
          {/* Its host's name on hover, after the name's last word. */}
          <span className="pointer-events-auto ms-2 inline-flex align-middle">
            <HostGlyph environmentId={port?.environmentId ?? server.environmentId} />
          </span>
        </ItemTitle>
        {port ? (
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
            {local && open ? (
              <Tip label="Open in browser">{link(`localhost:${port.number}`, open.url, `Open localhost:${port.number}`)}</Tip>
            ) : (
              <span className="shrink-0">localhost:{port.number}</span>
            )}
            {open && !local ? link(`${open.label} :${open.port}`, open.url, `${open.label}, port ${open.port}`) : null}
          </div>
        ) : null}
        {error ? <div className="text-xs text-pretty break-words text-destructive">{error}</div> : null}
        {!error && server.stopping ? (
          <div className="truncate text-xs text-muted-foreground">{server.stopping}</div>
        ) : null}
      </ItemContent>
      <ItemActions className={cn(picks && ROW_CONTROLS)}>
        {/* The word says what it does: no tooltip. */}
        <Button
          variant="ghost"
          size="xs"
          disabled={pending}
          aria-busy={pending || undefined}
          className="text-muted-foreground hover:text-foreground"
          onClick={stop}
        >
          <BusyLabel busy={pending} label="Stop" />
        </Button>
      </ItemActions>
    </Item>
  );
}
