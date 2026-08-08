import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ClaimApp from "../app/ClaimApp";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClaimApp user={null} storageMode="local" />
  </StrictMode>,
);
