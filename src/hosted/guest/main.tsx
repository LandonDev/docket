import { createRoot } from "react-dom/client";
import "./guest.css";
import { GuestApp } from "./GuestApp";

const viewport = document.querySelector<HTMLMetaElement>("meta[name=viewport]");
if (viewport && "virtualKeyboard" in navigator) viewport.content += ", interactive-widget=resizes-content";

createRoot(document.getElementById("root")!).render(<GuestApp />);
