import { createRoot } from "react-dom/client";
import "./guest.css";
import { GuestApp } from "./GuestApp";

createRoot(document.getElementById("root")!).render(<GuestApp />);
