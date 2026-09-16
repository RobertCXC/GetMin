import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import styles from "../styles.css?inline";

const styleElement = document.createElement("style");
styleElement.dataset.stockMarketStyles = "true";
styleElement.textContent = styles;
document.head.appendChild(styleElement);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
