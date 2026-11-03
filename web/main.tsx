import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Placeholder until the app shell lands (Task 10).
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <div>Loading…</div>
  </StrictMode>,
);
