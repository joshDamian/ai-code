// Installing Bench as an app. Chrome announces that a page can be installed with
// `beforeinstallprompt`, often before any view has mounted, so it is caught here, at
// startup, and kept for the Install button in Settings. The button does not depend on
// where a browser's menu puts its own install item, and whether the event ever came is
// itself the answer to "does this browser think Bench is installable?".
import { useEffect, useState } from './lib.mjs';

/** @type {any} */
let deferred = null;
let installed = false;
const listeners = new Set();
const notify = () => listeners.forEach((l) => l());

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  notify();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  installed = true;
  notify();
});

const standalone = () => matchMedia('(display-mode: standalone)').matches || /** @type {any} */ (navigator).standalone === true;

/** @returns {{state: 'app'|'installed'|'ready'|'unavailable', install: () => Promise<string>}} */
export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  const state = standalone() ? 'app' : installed ? 'installed' : deferred ? 'ready' : 'unavailable';
  const install = async () => {
    if (!deferred) return 'unavailable';
    const e = deferred;
    deferred = null;
    await e.prompt();
    const { outcome } = await e.userChoice;
    notify();
    return outcome;
  };
  return { state, install };
}
