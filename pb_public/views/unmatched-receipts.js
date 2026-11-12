// Ablage „Lieferscheine ohne Bestellung“ (ARCHITECTURE.md Kap. 4.6) – Abschnitt im Dashboard,
// nur sichtbar, wenn etwas abgelegt ist. Zuordnen hängt den Beleg an eine Bestellung.
import { supplierLabel, orderNumbersLabel, statusMeta } from '../core/config.js';
import {
  listUnmatchedReceipts, assignUnmatchedReceipt, deleteUnmatchedReceipt, fileUrl, subscribe, errorMessage,
} from '../core/api.js';
import { pb } from '../core/pb.js';
import { fmt, toast, confirmAction } from '../core/ui.js';

export const unmatchedReceiptsSection = /* html */ `
<section x-data="unmatchedReceipts" x-show="entries.length" class="mb-4 rounded-xl border border-violet-200 bg-violet-50/50 p-3" data-unmatched-receipts>
  <h2 class="mb-2 text-sm font-semibold text-violet-900">
    Lieferscheine ohne Bestellung <span class="font-normal" x-text="'(' + entries.length + ')'"></span>
  </h2>
  <ul class="space-y-2">
    <template x-for="r in entries" :key="r.id">
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
          <button type="button" class="btn btn-secondary btn-sm" :disabled="!target[r.id] || busy" @click="assign(r)">Zuordnen</button>
          <button type="button" class="btn btn-ghost btn-sm text-red-700" :disabled="busy" @click="remove(r)">Löschen</button>
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
    busy: false,
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

    async reload() {
      try {
        this.entries = await listUnmatchedReceipts();
      } catch (err) {
        console.warn('Ablage nicht geladen', err);
      }
    },

    /** Bestellungen zur Auswahl (neueste zuerst; abgerechnete ausgenommen). */
    async loadOrders() {
      if (this.orders.length) return;
      try {
        this.orders = await pb.collection('orders').getFullList({ filter: 'status != "abgerechnet"', sort: '-updated' });
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    async assign(r) {
      const order = this.orders.find((o) => o.id === this.target[r.id]);
      if (!order || !confirmAction(`Lieferschein an die Bestellung ${supplierLabel(order)} · ${orderNumbersLabel(order)} anhängen?`)) return;
      this.busy = true;
      try {
        await assignUnmatchedReceipt(r.id, order.id);
        toast.success('Lieferschein an die Bestellung angehängt.');
        await this.reload();
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    async remove(r) {
      if (!confirmAction(`Abgelegten Lieferschein „${r.supplier_name}“ endgültig löschen?`)) return;
      this.busy = true;
      try {
        await deleteUnmatchedReceipt(r.id);
        await this.reload();
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },
  }));
}
