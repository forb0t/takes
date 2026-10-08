import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { PlayerProvider } from "./player";
import { ToastProvider } from "./ui";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <PlayerProvider>
        <App />
      </PlayerProvider>
    </ToastProvider>
  </StrictMode>,
);
