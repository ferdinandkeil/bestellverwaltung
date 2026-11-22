// Ablage „Lieferscheine ohne Bestellung“ (ARCHITECTURE.md Kap. 4.6) – Abschnitt im Dashboard,
// nur sichtbar, wenn etwas abgelegt ist. Zuordnen hängt den Beleg an eine Bestellung.
// Zuordnen und Löschen ohne Rückfrage, verzögert mit „Rückgängig“ (ARCHITECTURE Kap. 7).
import { supplierLabel, orderNumbersLabel, statusMeta } from '../core/config.js';
import {
  listUnmatchedReceipts, assignUnmatchedReceipt, deleteUnmatchedReceipt, fileUrl, subscribe, errorMessage,
} from '../core/api.js';
import { pb } from '../core/pb.js';
import { fmt, toast, deferredAction } from '../core/ui.js';

export const unmatchedReceiptsSection = /* html */ `
<section x-data="unmatchedReceipts" x-show="visible().length" class="mb-4 rounded-xl border border-violet-200 bg-violet-50/50 p-3" data-unmatched-receipts>
  <h2 class="mb-2 text-sm font-semibold text-violet-900">
    Lieferscheine ohne Bestellung <span class="font-normal" x-text="'(' + visible().length + ')'"></span>
  </h2>
  <ul class="space-y-2">
    <template x-for="r in visible()" :key="r.id">
      <li class="card p-3 text-sm">
        <div class="flex flex-wrap items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="font-medium" x-text="r.supplier_name + (r.internal_order_no ? ' · ' + r.internal_order_no : '')"></div>
            <div class="text-xs text-slate-500" x-text="fmt.dateTime(r.created) + (r.expand?.uploaded_by ? ' · ' + (r.expand.uploaded_by.name || r.expand.uploaded_by.email) : '')"></div>
            <div x-show="r.note" class="mt-1 text-xs text-slate-700" x-text="r.note"></div>
          </div>
          <a :href="fileUrl(r, r.receipt)" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">Beleg ↗</a>
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <select class="input w-full min-w-0 sm:w-auto sm:flex-1" x-model="target[r.id]" @focus="loadOrders()" :aria-label="'Bestellung für Lieferschein ' + r.supplier_name">
            <option value="">– Bestellung wählen –</option>
            <template x-for="o in orders" :key="o.id">
              <option :value="o.id" x-text="supplierLabel(o) + ' · ' + orderNumbersLabel(o) + ' · ' + statusMeta(o.status).label"></option>
            </template>
          </select>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="!target[r.id]" @click="assign(r)">Zuordnen</button>
          <button type="button" class="btn btn-ghost btn-sm text-red-700" @click="remove(r)">Löschen</button>
        </div>
      </li>
    </template>
  </ul>
</section>`;

export function registerUnmatchedReceipts(Alpine) {
  Alpine.data('unmatchedReceipts', () => ({
    supplierLabel, orderNumbersLabel, statusMeta, fileUrl, fmt,
    entries: [],
    orders: [],
    target: {},
    pending: {}, // ausgeblendet, Aktion läuft verzögert (Rückgängig möglich)
    unsubscribe: null,

    async init() {
      await this.reload();
      try {
        this.unsubscribe = await subscribe(['unmatched_receipts'], () => this.reload());
      } catch { /* Realtime optional */ }
    },

    destroy() {
      this.unsubscribe?.();
    },

    visible() {
      return this.entries.filter((r) => !this.pending[r.id]);
    },

    /** Eintrag sofort ausblenden, Aktion nach Ablauf des Toasts ausführen; „Rückgängig“ blendet wieder ein. */
    async later(r, message, run, success) {
      this.pending = { ...this.pending, [r.id]: true };
      const show = () => { const { [r.id]: _, ...rest } = this.pending; this.pending = rest; };
      try {
        if (await deferredAction({ message, run, undo: show })) {
          if (success) toast.success(success);
          await this.reload();
          show();
        }
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    async reload() {
      try {
        this.entries = await listUnmatchedReceipts();
      } catch (err) {
        console.warn('Ablage nicht geladen', err);
      }
    },

    /** Bestellungen zur Auswahl (neueste zuerst; abgeschlossene ausgenommen). */
    async loadOrders() {
      if (this.orders.length) return;
      try {
        this.orders = await pb.collection('orders').getFullList({ filter: 'status != "abgeschlossen"', sort: '-updated' });
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    assign(r) {
      const order = this.orders.find((o) => o.id === this.target[r.id]);
      if (!order) return;
      this.later(r, `Lieferschein „${r.supplier_name}“ wird an ${supplierLabel(order)} · ${orderNumbersLabel(order)} angehängt.`,
        () => assignUnmatchedReceipt(r.id, order.id), 'Lieferschein an die Bestellung angehängt.');
    },

    remove(r) {
      this.later(r, `Abgelegter Lieferschein „${r.supplier_name}“ wird gelöscht.`, () => deleteUnmatchedReceipt(r.id));
    },
  }));
}
