import { purgeLegacy } from "./api.js";
import { startGate, hideGate, fatalError } from "./gate.js";
import { startApp } from "./app.js";

purgeLegacy(); // first: wipe the old CV/key from localStorage before anything reads storage
try {
  const result = await startGate();
  startApp(result);
  hideGate();
} catch (e) {
  console.error("start failed", e && e.name);
  fatalError(); // plain "Ceva nu a mers" screen with "Încearcă din nou" (reload), never an endless spinner
}
