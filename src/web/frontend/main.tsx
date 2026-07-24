import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("slop web: #root mount point missing from the served shell HTML");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
