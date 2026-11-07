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
}

export const toast = {
  info: (msg) => Alpine.store('toasts').push(msg, 'info'),
  success: (msg) => Alpine.store('toasts').push(msg, 'success'),
  error: (msg) => Alpine.store('toasts').push(msg, 'error', 8000),
};

/** Sicherheitsabfrage. Bewusst nativ: zuverlässig auf Smartphones, ohne eigenes Modal-System. */
export function confirmAction(message) {
  return window.confirm(message);
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
