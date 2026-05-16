import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";
// Side-effect import: the theme provider runs its initialization
// (reads localStorage + sets `data-theme` on <html>) at module load
// — BEFORE React mounts. Without this, the first paint would use
// whatever the OS preference is, then flicker to the user's stored
// choice on the next frame. Importing here, after `./index.css` but
// before `ReactDOM.createRoot`, gives us a flash-free initial paint.
import "./lib/theme";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
