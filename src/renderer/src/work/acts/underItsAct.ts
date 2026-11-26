import { createContext } from "react";

/**
 * A view drawn under a row that already says its act in the host's words (the Outbox's summary list opened in place,
 * "Post in Teams to Esports Staff › General"): a place line there would say the chat twice. A module of its own, so
 * the Outbox's detail sets it without the views' parts.
 */
export const UnderItsAct = createContext(false);
