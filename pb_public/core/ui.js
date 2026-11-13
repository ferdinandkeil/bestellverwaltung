// Gemeinsame UI-Helfer: Toasts, Bestätigungen, Formatierung.
import Alpine from '../vendor/alpinejs@3.17.5/dist/module.esm.js';

export function initUiStore() {
  Alpine.store('toasts', {
    items: [],
    push(message, type = 'info', timeoutMs = 4000) {
      const id = Math.random().toString(36).slice(2);
      // Höchstens drei Meldungen gleichzeitig, damit der Inhalt sichtbar bleibt.
      this.items = [...this.items.slice(-2), { id, message, type }];
      if (timeoutMs) setTimeout(() => this.dismiss(id), timeoutMs);
    },
    dismiss(id) {
      this.items = this.items.filter((t) => t.id !== id);
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

export const toast = {
  info: (msg) => Alpine.store('toasts').push(msg, 'info'),
  success: (msg) => Alpine.store('toasts').push(msg, 'success'),
  error: (msg) => Alpine.store('toasts').push(msg, 'error', 8000),
};

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

export const fmt = {
  eur: (n) => eur.format(n || 0),
  dateTime: (s) => (s ? dateTime.format(new Date(s.replace(' ', 'T'))) : ''),
  date: (s) => (s ? date.format(new Date(s.replace(' ', 'T'))) : ''),
};

/** Leere Zeichenkette → null, sonst Zahl (für optionale Zahlenfelder). */
export function numberOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
