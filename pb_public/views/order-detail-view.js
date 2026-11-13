// Bestell-Detail: Positionen, Lieferbuchungen, Storno, Status, Kosten, Anhänge, Plugin-Slot.
import {
  supplierLabel, statusMeta, groupsByCourse, INTERNAL_ORDER_NO_RE, EDITABLE_STATUSES, DELIVERY_STATUSES, ADVANCE_LABELS, BACK_ALLOWED, VAT_RATE,
} from '../core/config.js';
import {
  getOrder, listOrderItems, listDeliveries, updateOrder, deleteOrder, updateItem, deleteItem,
  changeOrderStatus, bookDelivery, uploadAttachments, removeAttachment, fileUrl, backlogOf, orderTotals,
  subscribe, errorMessage, addLateItem, listGroups,
} from '../core/api.js';
import { getPlugins } from '../core/plugin-registry.js';
import { fmt, toast, confirmAction, numberOrNull } from '../core/ui.js';
import { itemFormFields } from './item-form.js';

/** Schnellbuttons werden so lange gesammelt, bevor eine gemeinsame Lieferbuchung entsteht. */
const QUICK_BOOK_DELAY_MS = 1500;

const template = /* html */ `
<div x-data="orderDetailView">
  <a href="#/" class="mb-3 inline-block text-sm text-blue-700 hover:underline">← Alle Bestellungen</a>

  <p x-show="error" x-text="error" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>
  <p x-show="!order && !error" class="py-8 text-center text-sm text-slate-500">Lade …</p>

  <template x-if="order">
    <div class="space-y-4">
      <!-- Kopf -->
      <section class="card p-4">
        <div class="flex flex-wrap items-start gap-2">
          <div class="mr-auto min-w-0">
            <h1 class="text-xl font-semibold" x-text="supplierLabel(order)"></h1>
            <p x-show="order.origin === 'lieferschein'" class="mb-1">
              <span class="badge bg-violet-50 text-violet-800 ring-violet-200">aus Lieferschein angelegt</span>
            </p>
            <p class="text-xs text-slate-500">
              Angelegt <span x-text="fmt.dateTime(order.created)"></span>
              <span x-show="order.expand?.created_by" x-text="'von ' + (order.expand?.created_by?.name || order.expand?.created_by?.email)"></span>
            </p>
          </div>
          <span class="badge text-sm" data-status-badge :class="statusMeta(order.status).badge" x-text="statusMeta(order.status).label"></span>
        </div>

        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label class="label" for="internal-order-no">Interne Bestellnummer</label>
            <input id="internal-order-no" class="input font-mono" x-model="orderForm.internal_order_no" @change="saveOrder('internal_order_no')"
                   maxlength="11" placeholder="z. B. 2026IW01047" autocapitalize="characters" spellcheck="false">
            <p class="hint" x-show="order.status === 'angefragt'">Pflicht für „Als bestellt markieren“.</p>
          </div>
          <div>
            <label class="label" for="supplier-order-no">Auftragsnummer des Shops <span class="font-normal text-slate-500">(optional)</span></label>
            <input id="supplier-order-no" class="input" x-model="orderForm.supplier_order_no" @change="saveOrder('supplier_order_no')" maxlength="100"
                   placeholder="aus der Bestellbestätigung">
          </div>
          <div class="sm:col-span-2">
            <label class="label">Notizen</label>
            <textarea class="input" rows="1" x-model="orderForm.notes" @change="saveOrder('notes')" maxlength="2000"></textarea>
          </div>
        </div>

        <!-- Status-Aktionen -->
        <div class="mt-4 flex flex-wrap gap-2">
          <template x-if="advanceLabel()">
            <button type="button" class="btn btn-primary" :disabled="busy" @click="advance()" x-text="advanceLabel()"></button>
          </template>
          <template x-if="canGoBack()">
            <button type="button" class="btn btn-secondary" :disabled="busy" @click="back()">Einen Schritt zurück</button>
          </template>
          <template x-for="p in plugins()" :key="p.id">
            <button type="button" class="btn btn-secondary" @click="runPlugin(p)" x-text="p.label"></button>
          </template>
          <template x-if="order.status === 'angefragt'">
            <button type="button" class="btn btn-danger ml-auto" :disabled="busy" @click="removeOrder()">Warenkorb löschen</button>
          </template>
        </div>
        <p x-show="['bestellt','teilgeliefert'].includes(order.status)" class="hint mt-2">
          Der Lieferstatus ergibt sich automatisch aus den Lieferbuchungen und Stornos.
        </p>
      </section>

      <!-- Positionen -->
      <section>
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <h2 class="mr-auto text-lg font-semibold">
            Positionen <span class="text-sm font-normal text-slate-500" x-text="'(' + items.length + ')'"></span>
          </h2>
          <template x-if="canDeliver()">
            <button type="button" class="btn btn-secondary" @click="openLateForm()">Position nachtragen</button>
          </template>
          <template x-if="canDeliver()">
            <button type="button" class="btn btn-success" @click="openDeliveryForm()">Lieferung erfassen</button>
          </template>
          <template x-if="order.status === 'angefragt'">
            <button type="button" class="btn btn-primary" @click="showItemForm = true">+ Position</button>
          </template>
        </div>

        <ul class="space-y-2">
          <template x-for="it in items" :key="it.id">
            <li class="card p-3">
              <!-- Ansicht -->
              <div x-show="editId !== it.id">
                <div class="flex items-start gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="font-mono text-sm font-semibold break-all" x-text="it.part_number"></div>
                    <div class="text-sm" :class="it.name ? 'text-slate-700' : 'italic text-slate-400'" x-text="it.name || 'ohne Bezeichnung'"></div>
                    <a x-show="it.url" :href="it.url" target="_blank" rel="noopener" class="text-xs text-blue-700 hover:underline">Zum Artikel ↗</a>
                    <div x-show="it.added_later_at" class="mt-1 text-xs text-violet-800">
                      <span class="badge bg-violet-50 text-violet-800 ring-violet-200">nachgetragen</span>
                      <span x-text="lateLabel(it)"></span>
                    </div>
                    <div x-show="it.group_allocation_note" class="mt-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900" x-text="it.group_allocation_note"></div>
                  </div>
                  <template x-if="canEditItems()">
                    <button type="button" class="btn btn-ghost btn-sm" @click="startEdit(it)">Bearbeiten</button>
                  </template>
                </div>

                <dl class="mt-2 grid grid-cols-4 gap-1 text-center text-xs">
                  <div class="rounded bg-slate-50 p-1.5"><dt class="text-slate-500">Bestellt</dt><dd class="text-base font-semibold" x-text="it.qty_ordered"></dd></div>
                  <div class="rounded bg-slate-50 p-1.5"><dt class="text-slate-500">Geliefert</dt><dd class="text-base font-semibold" x-text="it.qty_delivered"></dd></div>
                  <div class="rounded bg-slate-50 p-1.5"><dt class="text-slate-500">Storniert</dt><dd class="text-base font-semibold" x-text="it.qty_cancelled || 0"></dd></div>
                  <div class="rounded p-1.5" :class="backlogOf(it) ? 'bg-amber-100' : 'bg-emerald-50'">
                    <dt class="text-slate-500">Rückstand</dt><dd class="text-base font-semibold" x-text="backlogOf(it)"></dd>
                  </div>
                </dl>

                <div class="mt-1 text-right text-xs text-slate-500" x-show="it.price_unit"
                     x-text="fmt.eur(it.price_unit) + ' / Stk. · ' + fmt.eur(it.price_unit * Math.max(0, it.qty_ordered - (it.qty_cancelled || 0)))"></div>

                <!-- Schnellbuchung (Smartphone) -->
                <template x-if="canDeliver()">
                  <div class="mt-2 flex items-center gap-2">
                    <button type="button" class="btn btn-secondary flex-1 py-3" @click="quickAdd(it, 1)">+1</button>
                    <button type="button" class="btn btn-success flex-1 py-3" :disabled="backlogOf(it) - (pending[it.id] || 0) <= 0"
                            @click="quickAdd(it, backlogOf(it) - (pending[it.id] || 0))">Rest komplett</button>
                    <span x-show="pending[it.id]" class="w-16 text-center text-xs text-blue-700" x-text="'+' + pending[it.id] + ' …'"></span>
                  </div>
                </template>
              </div>

              <!-- Bearbeiten -->
              <template x-if="editId === it.id">
                <form @submit.prevent="saveEdit(it)" class="space-y-3">
                  <div class="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label class="label">Bestellnummer des Shops</label>
                      <input class="input font-mono" x-model="edit.part_number" required maxlength="100">
                    </div>
                    <div>
                      <label class="label">Bezeichnung <span class="font-normal text-slate-500">(empfohlen)</span></label>
                      <input class="input" x-model="edit.name" maxlength="300">
                    </div>
                    <div class="sm:col-span-2">
                      <label class="label">Link</label>
                      <input class="input" type="url" x-model="edit.url">
                    </div>
                    <div>
                      <label class="label">Bestellte Menge</label>
                      <input class="input" type="number" min="1" step="1" x-model.number="edit.qty_ordered" required>
                      <p class="hint" x-show="allocationSum(it) && allocationSum(it) !== edit.qty_ordered"
                         x-text="'Hinweis: Gruppenanteile ergeben ' + allocationSum(it) + ' Stück.'"></p>
                    </div>
                    <div>
                      <label class="label">Stückpreis netto</label>
                      <input class="input" type="text" inputmode="decimal" x-model="edit.price_unit">
                    </div>
                    <template x-if="order.status !== 'angefragt'">
                      <div>
                        <label class="label">Stornierte Menge</label>
                        <input class="input" type="number" min="0" step="1" x-model.number="edit.qty_cancelled"
                               :max="Math.max(0, edit.qty_ordered - it.qty_delivered)">
                        <p class="hint">Vom Shop storniert oder nicht lieferbar.</p>
                      </div>
                    </template>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <button type="submit" class="btn btn-primary" :disabled="busy">Speichern</button>
                    <button type="button" class="btn btn-secondary" @click="editId = null">Abbrechen</button>
                    <template x-if="order.status === 'angefragt'">
                      <button type="button" class="btn btn-danger ml-auto" @click="removeItem(it)">Position löschen</button>
                    </template>
                  </div>
                </form>
              </template>
            </li>
          </template>
        </ul>
        <p x-show="!items.length" class="card p-6 text-center text-sm text-slate-500">Keine Positionen.</p>
      </section>

      <!-- Kosten -->
      <section class="card p-4">
        <h2 class="mb-3 text-lg font-semibold">Kosten</h2>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="label">Versandkosten netto</label>
            <input class="input" type="text" inputmode="decimal" x-model="orderForm.shipping_cost" @change="saveOrder('shipping_cost')" placeholder="0,00">
          </div>
          <div>
            <label class="label">Rechnungsbetrag brutto (laut Rechnung)</label>
            <input class="input" type="text" inputmode="decimal" x-model="orderForm.invoice_total" @change="saveOrder('invoice_total')" placeholder="bei Abrechnung eintragen">
          </div>
        </div>
        <dl class="mt-4 space-y-1 text-sm">
          <div class="flex justify-between"><dt>Positionen netto</dt><dd x-text="fmt.eur(totals().itemsNet)"></dd></div>
          <div class="flex justify-between"><dt>Versand netto</dt><dd x-text="fmt.eur(totals().shipping)"></dd></div>
          <div class="flex justify-between border-t border-slate-200 pt-1 font-medium"><dt>Summe netto</dt><dd x-text="fmt.eur(totals().net)"></dd></div>
          <div class="flex justify-between text-slate-600"><dt x-text="'MwSt. ' + Math.round(vatRate * 100) + ' %'"></dt><dd x-text="fmt.eur(totals().vat)"></dd></div>
          <div class="flex justify-between font-semibold"><dt>Summe brutto</dt><dd x-text="fmt.eur(totals().gross)"></dd></div>
          <div x-show="order.invoice_total" class="flex justify-between text-slate-600">
            <dt>Abweichung zur Rechnung</dt><dd x-text="fmt.eur(order.invoice_total - totals().gross)"></dd>
          </div>
        </dl>
        <p x-show="totals().missingPrices" class="hint mt-2"
           x-text="totals().missingPrices + ' Position(en) ohne Stückpreis – Summe unvollständig.'"></p>
      </section>

      <!-- Lieferhistorie -->
      <section class="card p-4" x-show="deliveries.length">
        <h2 class="mb-3 text-lg font-semibold">Lieferhistorie</h2>
        <ul class="divide-y divide-slate-100">
          <template x-for="d in deliveries" :key="d.id">
            <li class="py-2 text-sm">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <span class="font-medium" x-text="fmt.dateTime(d.created)"></span>
                <span class="text-xs text-slate-500" x-text="d.expand?.booked_by?.name || d.expand?.booked_by?.email || ''"></span>
                <a x-show="d.receipt" :href="fileUrl(d, d.receipt)" target="_blank" rel="noopener" class="text-xs text-blue-700 hover:underline">Beleg ↗</a>
              </div>
              <div x-show="d.note" class="text-xs text-slate-600" x-text="d.note"></div>
              <ul class="mt-1 flex flex-wrap gap-1">
                <template x-for="line in (d.expand?.delivery_items_via_delivery ?? [])" :key="line.id">
                  <li class="rounded px-1.5 py-0.5 font-mono text-xs"
                      :class="line.qty < 0 ? 'bg-red-50 text-red-700' : 'bg-slate-100'"
                      x-text="partNumberOf(line.order_item) + ': ' + (line.qty > 0 ? '+' : '') + line.qty"></li>
                </template>
              </ul>
            </li>
          </template>
        </ul>
      </section>

      <!-- Anhänge -->
      <section class="card p-4">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="mr-auto text-lg font-semibold">Anhänge</h2>
          <label class="btn btn-secondary cursor-pointer">
            Datei hinzufügen
            <input type="file" class="hidden" multiple accept="image/jpeg,image/png,image/webp,application/pdf" @change="upload($event)">
          </label>
        </div>
        <ul class="grid grid-cols-2 gap-2 sm:grid-cols-4" x-show="(order.attachments || []).length">
          <template x-for="f in order.attachments" :key="f">
            <li class="relative overflow-hidden rounded-lg border border-slate-200">
              <a :href="fileUrl(order, f)" target="_blank" rel="noopener" class="block">
                <template x-if="!f.toLowerCase().endsWith('.pdf')">
                  <img :src="fileUrl(order, f, '200x200')" :alt="f" class="aspect-square w-full object-cover" loading="lazy">
                </template>
                <template x-if="f.toLowerCase().endsWith('.pdf')">
                  <div class="flex aspect-square items-center justify-center bg-slate-50 text-sm font-semibold text-slate-500">PDF</div>
                </template>
                <div class="truncate px-2 py-1 text-xs" x-text="f"></div>
              </a>
              <button type="button" class="absolute right-1 top-1 rounded bg-white/90 px-1.5 text-xs text-red-700 shadow"
                      @click="removeFile(f)" aria-label="Anhang löschen">✕</button>
            </li>
          </template>
        </ul>
        <p x-show="!(order.attachments || []).length" class="text-sm text-slate-500">Noch keine Anhänge.</p>
      </section>

      <!-- Modal: Position hinzufügen -->
      <div x-show="showItemForm" x-transition.opacity class="modal-backdrop" @click.self="showItemForm = false"
           @keydown.escape.window="showItemForm = false">
        <div class="modal-panel" @item-form-cancel="showItemForm = false" @item-added="reload()">
          <h2 class="mb-4 text-lg font-semibold">Position hinzufügen</h2>
          <template x-if="showItemForm">
            <div x-data="itemForm({ supplier: order.supplier, supplierCustomName: order.supplier_custom_name, lockSupplier: true })">${itemFormFields}</div>
          </template>
        </div>
      </div>

      <!-- Modal: Position nachtragen -->
      <div x-show="late.open" x-transition.opacity class="modal-backdrop" @click.self="late.open = false"
           @keydown.escape.window="late.open = false">
        <form class="modal-panel space-y-3" @submit.prevent="submitLate()">
          <h2 class="text-lg font-semibold">Position nachtragen</h2>
          <p class="text-sm text-slate-600">Für Ware, die bestellt wurde, aber beim Erfassen vergessen wurde. Die Position wird als „nachgetragen“ gekennzeichnet.</p>
          <div>
            <label class="label" for="late-part">Bestellnummer des Shops</label>
            <input id="late-part" class="input font-mono" x-model="late.part_number" required maxlength="100" autocapitalize="characters" spellcheck="false">
          </div>
          <div>
            <label class="label">Bezeichnung <span class="font-normal text-slate-500">(empfohlen)</span></label>
            <input class="input" x-model="late.name" maxlength="300">
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="label" for="late-qty">Bestellte Menge</label>
              <input id="late-qty" class="input" type="number" min="1" step="1" x-model.number="late.qty" required>
            </div>
            <div>
              <label class="label">Gruppe <span class="font-normal text-slate-500">(optional)</span></label>
              <select class="input" x-model="late.group">
                <option value="">– ohne Gruppe –</option>
                <template x-for="c in late.courses" :key="c.label">
                  <optgroup :label="c.label">
                    <template x-for="g in c.groups" :key="g.id"><option :value="g.id" x-text="g.name"></option></template>
                  </optgroup>
                </template>
              </select>
            </div>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" x-model="late.delivered"> Menge gleich als geliefert buchen
          </label>
          <div class="flex flex-wrap justify-end gap-2">
            <button type="button" class="btn btn-secondary" @click="late.open = false">Abbrechen</button>
            <button type="submit" class="btn btn-primary" :disabled="busy">Nachtragen</button>
          </div>
        </form>
      </div>

      <!-- Modal: Lieferung erfassen -->
      <div x-show="delivery.open" x-transition.opacity class="modal-backdrop" @click.self="delivery.open = false"
           @keydown.escape.window="delivery.open = false">
        <form class="modal-panel space-y-3" @submit.prevent="submitDelivery()">
          <h2 class="text-lg font-semibold">Lieferung erfassen</h2>
          <p class="text-xs text-slate-500">Gelieferte Mengen eintragen. Negative Werte korrigieren frühere Buchungen.</p>
          <ul class="divide-y divide-slate-100">
            <template x-for="it in items" :key="it.id">
              <li class="flex items-center gap-2 py-2">
                <div class="min-w-0 flex-1">
                  <div class="truncate font-mono text-xs font-semibold" x-text="it.part_number"></div>
                  <div x-show="it.name" class="truncate text-xs text-slate-500" x-text="it.name"></div>
                  <div class="text-xs text-slate-500" x-text="'Rückstand ' + backlogOf(it)"></div>
                </div>
                <button type="button" class="btn btn-ghost btn-sm" @click="delivery.qty[it.id] = backlogOf(it)" :disabled="!backlogOf(it)">Rest</button>
                <input class="input w-20 text-right" type="number" step="1" inputmode="numeric" x-model.number="delivery.qty[it.id]">
              </li>
            </template>
          </ul>
          <div>
            <label class="label">Notiz (optional)</label>
            <input class="input" x-model="delivery.note" maxlength="500" placeholder="z. B. Paket 1 von 2">
          </div>
          <div>
            <label class="label">Lieferschein / Beleg (optional)</label>
            <input class="input" type="file" accept="image/*,application/pdf" capture="environment" @change="delivery.receipt = $event.target.files[0] || null">
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn btn-secondary" @click="delivery.open = false">Abbrechen</button>
            <button type="submit" class="btn btn-success" :disabled="busy">Buchen</button>
          </div>
        </form>
      </div>
    </div>
  </template>
</div>`;

function component() {
  return {
    supplierLabel, statusMeta, backlogOf, fileUrl, fmt,
    vatRate: VAT_RATE,
    order: null,
    items: [],
    deliveries: [],
    error: '',
    busy: false,
    orderForm: {},
    editId: null,
    edit: {},
    showItemForm: false,
    pending: {},
    pendingTimer: null,
    delivery: { open: false, qty: {}, note: '', receipt: null },
    late: { open: false, part_number: '', name: '', qty: 1, group: '', delivered: false, courses: [] },
    unsubscribe: null,

    get orderId() {
      return this.$store.route.params.id;
    },

    async init() {
      await this.reload();
      try {
        this.unsubscribe = await subscribe(['orders', 'order_items', 'deliveries'], () => this.reload());
      } catch (err) {
        console.warn('Realtime nicht verfügbar', err);
      }
    },

    destroy() {
      this.unsubscribe?.();
      if (this.pendingTimer) this.flushPending();
    },

    async reload() {
      try {
        const [order, items, deliveries] = await Promise.all([
          getOrder(this.orderId), listOrderItems(this.orderId), listDeliveries(this.orderId),
        ]);
        this.order = order;
        this.items = items;
        this.deliveries = deliveries;
        this.orderForm = {
          internal_order_no: order.internal_order_no || '',
          supplier_order_no: order.supplier_order_no || '',
          notes: order.notes || '',
          shipping_cost: order.shipping_cost ? String(order.shipping_cost).replace('.', ',') : '',
          invoice_total: order.invoice_total ? String(order.invoice_total).replace('.', ',') : '',
        };
        this.error = '';
      } catch (err) {
        this.error = err?.status === 404 ? 'Bestellung nicht gefunden.' : errorMessage(err);
        this.order = null;
      }
    },

    // ---- Plugins -----------------------------------------------------------
    plugins() {
      void this.$store.plugins.version;
      return getPlugins('order-detail-actions', this.order, this.items);
    },
    runPlugin(p) {
      try {
        p.onClick(this.order, this.items);
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    // ---- Zustände ----------------------------------------------------------
    canEditItems() { return EDITABLE_STATUSES.includes(this.order?.status); },
    canDeliver() { return DELIVERY_STATUSES.includes(this.order?.status); },
    advanceLabel() { return ADVANCE_LABELS[this.order?.status] || ''; },
    canGoBack() { return BACK_ALLOWED.includes(this.order?.status); },
    totals() { return orderTotals(this.order, this.items); },
    allocationSum(it) { return (it.group_allocations || []).reduce((s, a) => s + (a.qty || 0), 0); },
    partNumberOf(itemId) { return this.items.find((i) => i.id === itemId)?.part_number || '(gelöscht)'; },

    // ---- Position nachtragen ----------------------------------------------
    lateLabel(it) {
      const who = it.expand?.added_later_by?.name || it.expand?.added_later_by?.email;
      return 'am ' + fmt.date(it.added_later_at) + (who ? ' von ' + who : '');
    },

    async openLateForm() {
      this.late = { open: true, part_number: '', name: '', qty: 1, group: '', delivered: false, courses: [] };
      try {
        this.late.courses = groupsByCourse(await listGroups({ onlyActive: true }));
      } catch (err) {
        toast.error(errorMessage(err));
      }
      this.$nextTick(() => document.getElementById('late-part')?.focus());
    },

    async submitLate() {
      const data = { part_number: this.late.part_number, name: this.late.name, qty: this.late.qty, group: this.late.group };
      this.busy = true;
      try {
        if (this.late.delivered) {
          await bookDelivery(this.order.id, [], { newItems: [data], note: 'Nachgetragene Position' });
          toast.success('Position nachgetragen und als geliefert gebucht.');
        } else {
          await addLateItem(this.order.id, data);
          toast.success('Position nachgetragen.');
        }
        this.late.open = false;
        await this.reload();
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    // ---- Bestellung --------------------------------------------------------
    async saveOrder(field) {
      let value = this.orderForm[field];
      if (field === 'internal_order_no') {
        value = value.trim().toUpperCase();
        this.orderForm.internal_order_no = value;
        if (value && !INTERNAL_ORDER_NO_RE.test(value)) {
          toast.error('Die interne Bestellnummer hat das Format JJJJIW##### (z. B. 2026IW01047).');
          return;
        }
      }
      if (field === 'shipping_cost' || field === 'invoice_total') {
        value = numberOrNull(value);
        if (this.orderForm[field] !== '' && value === null) {
          toast.error('Bitte eine gültige Zahl eingeben.');
          return;
        }
        value = value ?? 0;
      }
      try {
        this.order = { ...this.order, ...(await updateOrder(this.order.id, { [field]: value })) };
        toast.success('Gespeichert.');
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    async advance() {
      let numbers = {};
      if (this.order.status === 'angefragt') {
        const internal = this.orderForm.internal_order_no.trim().toUpperCase();
        if (!INTERNAL_ORDER_NO_RE.test(internal)) {
          toast.error('Bitte zuerst die interne Bestellnummer eintragen (Format JJJJIW#####, z. B. 2026IW01047).');
          document.getElementById('internal-order-no')?.focus();
          return;
        }
        if (!(await confirmAction(
          'Warenkorb als bestellt markieren? Neue Positionen für diesen Lieferanten landen danach in einem neuen Warenkorb.',
          { confirmLabel: 'Als bestellt markieren' }))) return;
        numbers = { internal_order_no: internal, supplier_order_no: this.orderForm.supplier_order_no.trim() };
      }
      await this.runStatus('advance', numbers);
    },

    async back() {
      if (!(await confirmAction(`Status „${statusMeta(this.order.status).label}“ wirklich einen Schritt zurücksetzen?`,
        { confirmLabel: 'Zurücksetzen' }))) return;
      await this.runStatus('back');
    },

    async runStatus(action, numbers) {
      this.busy = true;
      try {
        await changeOrderStatus(this.order.id, action, numbers);
        await this.reload();
        toast.success(`Status: ${statusMeta(this.order.status).label}`);
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    async removeOrder() {
      if (!(await confirmAction('Diesen Warenkorb mit allen Positionen endgültig löschen?', { confirmLabel: 'Löschen', danger: true }))) return;
      try {
        await deleteOrder(this.order.id);
        toast.success('Warenkorb gelöscht.');
        location.hash = '#/';
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    // ---- Positionen bearbeiten ---------------------------------------------
    startEdit(it) {
      this.editId = it.id;
      this.edit = {
        part_number: it.part_number,
        name: it.name,
        url: it.url || '',
        qty_ordered: it.qty_ordered,
        qty_cancelled: it.qty_cancelled || 0,
        price_unit: it.price_unit ? String(it.price_unit).replace('.', ',') : '',
      };
    },

    async saveEdit(it) {
      const price = numberOrNull(this.edit.price_unit);
      if (this.edit.price_unit !== '' && price === null) {
        toast.error('Der Stückpreis ist keine gültige Zahl.');
        return;
      }
      const data = { ...this.edit, price_unit: price ?? 0 };
      if (this.order.status === 'angefragt') delete data.qty_cancelled;
      this.busy = true;
      try {
        await updateItem(it.id, data);
        this.editId = null;
        await this.reload();
        toast.success('Position gespeichert.');
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    async removeItem(it) {
      if (!(await confirmAction(`Position ${it.part_number} löschen?`, { confirmLabel: 'Löschen', danger: true }))) return;
      try {
        await deleteItem(it.id);
        this.editId = null;
        await this.reload();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    // ---- Lieferungen -------------------------------------------------------
    /** Schnellbuttons sammeln und nach kurzer Pause gemeinsam buchen. */
    quickAdd(it, qty) {
      if (qty <= 0) return;
      this.pending = { ...this.pending, [it.id]: (this.pending[it.id] || 0) + qty };
      clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => this.flushPending(), QUICK_BOOK_DELAY_MS);
    },

    async flushPending() {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      const lines = Object.entries(this.pending).map(([item, qty]) => ({ item, qty }));
      this.pending = {};
      if (!lines.length) return;
      try {
        await bookDelivery(this.order.id, lines);
        await this.reload();
        toast.success('Lieferung gebucht.');
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    openDeliveryForm() {
      this.delivery = { open: true, qty: Object.fromEntries(this.items.map((i) => [i.id, 0])), note: '', receipt: null };
    },

    async submitDelivery() {
      const lines = Object.entries(this.delivery.qty)
        .map(([item, qty]) => ({ item, qty: Number(qty) || 0 }))
        .filter((l) => l.qty !== 0);
      if (!lines.length) {
        toast.error('Bitte mindestens eine Menge eintragen.');
        return;
      }
      this.busy = true;
      try {
        await bookDelivery(this.order.id, lines, { note: this.delivery.note, receipt: this.delivery.receipt });
        this.delivery.open = false;
        await this.reload();
        toast.success('Lieferung gebucht.');
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    // ---- Anhänge -----------------------------------------------------------
    async upload(event) {
      const files = [...event.target.files];
      event.target.value = '';
      if (!files.length) return;
      try {
        await uploadAttachments(this.order.id, files);
        await this.reload();
        toast.success(files.length === 1 ? 'Anhang hochgeladen.' : `${files.length} Anhänge hochgeladen.`);
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    async removeFile(name) {
      if (!(await confirmAction(`Anhang „${name}“ löschen?`, { confirmLabel: 'Löschen', danger: true }))) return;
      try {
        await removeAttachment(this.order.id, name);
        await this.reload();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
  };
}

export default { dataName: 'orderDetailView', template, component };
