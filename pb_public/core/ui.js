// Gemeinsame UI-Helfer: Toasts (mit Aktionen wie „Rückgängig“), verzögerte Aktionen, Bestätigungen, Formatierung.
// Grundsatz „Handeln statt fragen“ (ARCHITECTURE Kap. 7): sofort ausführen, im Toast „Rückgängig“ anbieten.
import Alpine from '../vendor/alpinejs@3.17.5/dist/module.esm.js';

// Symbole (Heroicons-Stil, 24×24, Strich) für Toast-Typen und -Aktionen. Feste Zeichenketten aus dem Code (x-html).
const svg = (d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-full" aria-hidden="true">${d}</svg>`;
const ICONS = {
  success: svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  error: svg('<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4M12 17h.01"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  calendar: svg('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
};

export function initUiStore() {
  Alpine.store('toasts', {
    items: [],
    /** actions: [{ label, icon, run }] – Knöpfe im Toast (icon: Schlüssel aus ICONS, z. B. 'undo', 'calendar');
     *  ein Klick führt run() aus und schließt den Toast. */
    push(message, type = 'info', timeoutMs = 4000, actions = []) {
      const id = Math.random().toString(36).slice(2);
      // Höchstens drei Meldungen gleichzeitig, damit der Inhalt sichtbar bleibt.
      this.items = [...this.items.slice(-2), { id, message, type, actions, timeoutMs }];
      if (timeoutMs) setTimeout(() => this.dismiss(id), timeoutMs);
      return id;
    },
    dismiss(id) {
      this.items = this.items.filter((t) => t.id !== id);
    },
    icon(name) {
      return ICONS[name] || '';
    },
    act(t, action) {
      this.dismiss(t.id);
      action.run();
    },
  });
  Alpine.store('confirm', {
    message: '',
    confirmLabel: '',
    cancelLabel: '',
    danger: false,
    resolve: null,
    /** Offene Abfrage beantworten (wird vom close-Ereignis des Dialogs aufgerufen). */
    settle(result) {
      const resolve = this.resolve;
      this.resolve = null;
      resolve?.(result);
    },
  });
}

/** Standzeit eines Toasts mit Aktionen (Zeit für „Rückgängig“) – auch die Verzögerung von deferredAction(). */
export const ACTION_TOAST_MS = 8000;

export const toast = {
  info: (msg) => Alpine.store('toasts').push(msg, 'info'),
  success: (msg) => Alpine.store('toasts').push(msg, 'success'),
  error: (msg) => Alpine.store('toasts').push(msg, 'error', 8000),
  /** Erfolgsmeldung mit Knöpfen, z. B. [{ label: 'Rückgängig', icon: 'undo', run }]. */
  done: (msg, actions) => Alpine.store('toasts').push(msg, 'success', ACTION_TOAST_MS, actions),
};

/**
 * Aktion verzögert ausführen (z. B. Löschen): sofort Toast mit „Rückgängig“, ausgeführt wird erst nach
 * ACTION_TOAST_MS. Der Aufrufer blendet das Element vorher aus und stellt es in undo() wieder her.
 * Wird der Browser-Tab vorher geschlossen, unterbleibt die Aktion (sichere Seite).
 * @returns {Promise<boolean>} true = ausgeführt, false = rückgängig gemacht; Fehler von run() werden weitergereicht
 */
export function deferredAction({ message, run, undo }) {
  return new Promise((resolve, reject) => {
    let cancelled = false;
    Alpine.store('toasts').push(message, 'info', ACTION_TOAST_MS, [{
      label: 'Rückgängig',
      icon: 'undo',
      run: () => { cancelled = true; undo?.(); resolve(false); },
    }]);
    setTimeout(async () => {
      if (cancelled) return;
      try {
        await run();
        resolve(true);
      } catch (err) {
        undo?.();
        reject(err);
      }
    }, ACTION_TOAST_MS);
  });
}

/**
 * Sicherheitsabfrage im eigenen Dialog (`#confirm-dialog` in index.html, natives <dialog> mit showModal:
 * oberste Ebene über allen Modals, Fokus bleibt im Dialog). Auf dem Smartphone als Bottom-Sheet.
 * Escape, Klick daneben und „Abbrechen“ zählen als Nein. Immer mit `await` verwenden.
 * @param {string} message Frage an den Nutzer
 * @param {{ confirmLabel?: string, cancelLabel?: string, danger?: boolean }} [options]
 *   confirmLabel: was passiert („Löschen“, „Buchen“ …); danger: roter Knopf für endgültiges Löschen/Verwerfen
 * @returns {Promise<boolean>}
 */
export async function confirmAction(message, { confirmLabel = 'Bestätigen', cancelLabel = 'Abbrechen', danger = false } = {}) {
  const store = Alpine.store('confirm');
  const dialog = document.getElementById('confirm-dialog');
  if (dialog.open) dialog.close('cancel');
  store.settle(false);
  Object.assign(store, { message, confirmLabel, cancelLabel, danger });
  const answer = new Promise((resolve) => { store.resolve = resolve; });
  await Alpine.nextTick();
  dialog.returnValue = '';
  dialog.showModal();
  // Bei Löschen/Verwerfen liegt der Fokus auf „Abbrechen“, damit Enter nichts zerstört.
  dialog.querySelector(danger ? '[value=cancel]' : '[value=ok]').focus();
  return answer;
}

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });
const shortDate = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });

export const fmt = {
  eur: (n) => eur.format(n || 0),
  dateTime: (s) => (s ? dateTime.format(new Date(s.replace(' ', 'T'))) : ''),
  date: (s) => (s ? date.format(new Date(s.replace(' ', 'T'))) : ''),
  /** 22.11.26 – für schmale Spalten */
  shortDate: (s) => (s ? shortDate.format(new Date(s.replace(' ', 'T'))) : ''),
};

/** Leere Zeichenkette → null, sonst Zahl (für optionale Zahlenfelder). */
export function numberOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
