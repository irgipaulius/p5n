import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { mountApp } from "./App";

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

mountApp(document.getElementById("app")!);
