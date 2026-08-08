import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import PublicApp from "./PublicApp";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PublicApp />
  </StrictMode>,
);
