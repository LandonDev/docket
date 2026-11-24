/** work-kit's collab-server `CLOSE_REVOKED`, a server module the page does not load; SheetPage reads the same number. */
export const CLOSE_REVOKED = 4403;

/**
 * The socket a guest's document opens through (the editor's `collab.socket`): the browser's own, told when the host
 * closes it as revoked (work-kit's `CLOSE_REVOKED`, 4403: the link was revoked, or took a new address). The editor
 * reads that close as trouble with the connection, and a reader whose text has loaded is shown no trouble at all, so
 * without this the page went on showing a document its link no longer opens. `onRevoked` asks the service once and
 * ends the page if the link is gone (DocPage). The sheet's page reads its own socket's 4403 (SheetPage).
 */
export function endingSocket(onRevoked: () => void, Base: typeof WebSocket = WebSocket): new (url: string) => WebSocket {
  return class EndingSocket extends Base {
    constructor(url: string) {
      super(url);
      this.addEventListener("close", (e) => {
        if (e.code === CLOSE_REVOKED) onRevoked();
      });
    }
  };
}
