// Registry für Erweiterungsmodule (ARCHITECTURE.md Kap. 5).
//
// registerPlugin({ id, slot, label, icon?, isVisible?(ctx...), onClick(ctx...) })
//   Slot 'dashboard-actions':    onClick(); Knopf oben auf der Startseite
//   Slot 'header-actions':       onClick(); Symbol (icon, label als Tooltip) in der Kopfzeile links neben dem
//                                Warenkorb, ab sm (z. B. Moodle-Import, Scanner)
//   Slot 'bottom-bar':           onClick(); nur Smartphone: runder Knopf (icon, label als aria-label) rechts neben der
//                                Navigation in der Leiste unten, in allen Ansichten (Hauptaufgabe: Scanner)
//   Slot 'order-detail-actions': onClick(order, items)

export const SLOTS = ['dashboard-actions', 'header-actions', 'bottom-bar', 'order-detail-actions'];

const plugins = [];
const listeners = new Set();

export function registerPlugin(plugin) {
  const { id, slot, label, onClick } = plugin ?? {};
  if (!id || typeof id !== 'string') throw new Error('Plugin benötigt eine id.');
  if (!SLOTS.includes(slot)) throw new Error(`Plugin ${id}: unbekannter Slot „${slot}“.`);
  if (!label) throw new Error(`Plugin ${id}: label fehlt.`);
  if (typeof onClick !== 'function') throw new Error(`Plugin ${id}: onClick fehlt.`);
  if (plugins.some((p) => p.id === id)) throw new Error(`Plugin ${id} ist bereits registriert.`);

  plugins.push(Object.freeze({ ...plugin }));
  listeners.forEach((fn) => fn());
}

/** Alle Plugins eines Slots, gefiltert über isVisible(...ctx). */
export function getPlugins(slot, ...ctx) {
  return plugins.filter((p) => p.slot === slot && (typeof p.isVisible !== 'function' || p.isVisible(...ctx)));
}

/** Benachrichtigung bei neu registrierten Plugins (z. B. nachgeladene Module). */
export function onPluginsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
