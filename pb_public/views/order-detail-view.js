// Bestell-Detail (ARCHITECTURE.md Kap. 7): Kopf, Ablauf, Positionen (Lieferungen und Storno in der Tabelle),
// Lieferhistorie, Anhänge, Plugin-Slot. Beträge werden nicht angezeigt (Kap. 4.1).
import {
  supplierLabel, statusMeta, stepMeta, groupsByCourse, INTERNAL_ORDER_NO_RE, DELIVERY_STATUSES,
} from '../core/config.js';
import {
  getOrder, listOrderItems, listDeliveries, listOrderSteps, updateOrder, deleteOrder, updateItem, deleteItem,
  bookDelivery, cancelDelivery, uploadAttachments, removeAttachment, fileUrl, backlogOf,
  subscribe, errorMessage, addLateItem, listGroups,
} from '../core/api.js';
import { getPlugins } from '../core/plugin-registry.js';
import { fmt, toast, confirmAction, deferredAction } from '../core/ui.js';
import { itemFormFields } from './item-form.js';
import { orderStepsSection, CHECK } from './order-steps.js';

/** Sammelzeit für Lieferungen aus der Tabelle: Einträge kurz hintereinander werden eine Lieferbuchung. */
const DELIVERY_COLLECT_MS = 3000;
/** Phasen, in denen Positionen bearbeitet werden (vor „bestellt“); danach nur noch Storno. */
const CART_STATUSES = ['angefragt', 'freigabe'];

const TRASH = '<svg viewBox="0 0 20 20" fill="currentColor" class="size-4" aria-hidden="true"><path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.44c-.8.08-1.58.18-2.36.3a.75.75 0 1 0 .22 1.49l.15-.03.8 10.1A2.75 2.75 0 0 0 7.55 18.6h4.9a2.75 2.75 0 0 0 2.74-2.54l.8-10.1.15.03a.75.75 0 1 0 .22-1.49c-.78-.12-1.57-.22-2.36-.3v-.44A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.67.03 2.5.08v-.33c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.33C8.33 4.03 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clip-rule="evenodd"/></svg>';
const CHEVRON = '<svg viewBox="0 0 20 20" fill="currentColor" class="size-5 shrink-0 text-slate-400 transition-transform" :class="openRow === it.id && \'rotate-180\'" aria-hidden="true"><path fill-rule="evenodd" d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg>';

/** Bestellte Menge mit Storno („10 −2“); ab „bestellt“ öffnet ein Klick das Feld „storniert“. */
const ORDERED_CELL = /* html */ `
<span class="inline-flex items-center justify-end gap-1 whitespace-nowrap">
  <template x-if="cancelId !== it.id">
    <button type="button" class="rounded px-1 tabular-nums" data-ordered :disabled="!canCancel()"
            :class="canCancel() ? 'cursor-pointer decoration-dotted hover:bg-slate-100 hover:underline' : 'cursor-default'"
            @click.stop="startCancel(it)">
      <span x-text="it.qty_ordered"></span><span x-show="it.qty_cancelled" class="ml-1 text-red-700" x-text="'−' + it.qty_cancelled"></span>
    </button>
  </template>
  <template x-if="cancelId === it.id">
    <label class="flex items-center gap-1 text-xs text-slate-500" @click.stop>storniert
      <input type="number" min="0" step="1" inputmode="numeric" class="input w-16 py-1 text-right" data-cancel-qty
             :max="maxCancel(it)" x-model.number="cancelQty" x-init="$nextTick(() => { $el.focus(); $el.select(); })"
             @keydown.enter.prevent="saveCancel(it)" @keydown.escape.prevent.stop="cancelId = null" @blur="saveCancel(it)">
    </label>
  </template>
</span>`;

/** Menge dieser Lieferung (Zahl vom Lieferschein); wird gesammelt und gemeinsam gebucht. */
const DELIVER_INPUT = /* html */ `
<input type="number" min="1" step="1" inputmode="numeric" class="input w-24 py-1 text-right" placeholder="Menge" data-deliver-qty
       :class="!backlogOf(it) && 'invisible'" :max="backlogOf(it)" :value="pending[it.id] || ''"
       :aria-label="'Gelieferte Menge ' + it.part_number" @click.stop
       @change="setPending(it, $event.target)" @focus="holdPending()" @blur="releasePending()"
       @keydown.enter.prevent="$event.target.blur()">`;

/** Kästchen „Rest geliefert“: grün = vollständig geliefert, blau = vorgemerkt, beim Überfahren graues Häkchen. */
const REST_BOX = /* html */ `
<button type="button" class="flex size-5 shrink-0 items-center justify-center rounded border" data-deliver-rest
        :class="!backlogOf(it) ? 'cursor-default border-emerald-600 bg-emerald-600 text-white'
          : pending[it.id] === backlogOf(it) ? 'cursor-pointer border-blue-600 bg-blue-600 text-white'
          : 'group/rest cursor-pointer border-slate-400 bg-white'"
        :disabled="!backlogOf(it)" :aria-pressed="pending[it.id] === backlogOf(it)"
        :aria-label="'Rest von ' + it.part_number + ' geliefert'" @click.stop="toggleRest(it)">
  <span x-show="!backlogOf(it) || pending[it.id] === backlogOf(it)">${CHECK}</span>
  <span x-show="backlogOf(it) && pending[it.id] !== backlogOf(it)" class="text-slate-400 opacity-0 group-hover/rest:opacity-100">${CHECK}</span>
</button>`;

/** Bezeichnung (wird kaum genutzt: schmal, gekürzt, voll im Tooltip) und Kennzeichen „nachgetragen“. */
const NAME_TEXT = /* html */ `
<span class="flex min-w-0 items-center gap-1.5">
  <span class="truncate" :class="it.name ? 'text-slate-600' : 'italic text-slate-400'" x-text="it.name || 'ohne Bezeichnung'" x-tip="it.name"></span>
  <span x-show="it.added_later_at" class="badge shrink-0 border-violet-200 bg-violet-50 text-violet-800" x-tip="lateLabel(it)">nachgetragen</span>
</span>`;

const EDIT_KEYS = '@click.stop @keydown.enter.prevent="saveEdit(it)" @keydown.escape.prevent.stop="cancelEdit()"';

const template = /* html */ `
<div x-data="orderDetailView" @order-steps-changed.window="$event.detail.orderId === orderId && reload()">
  <a href="#/" class="mb-3 inline-block text-sm text-blue-700 hover:underline">← Alle Bestellungen</a>

  <p x-show="error" x-text="error" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>
  <p x-show="!order && !error" class="py-8 text-center text-sm text-slate-500">Lade …</p>

  <template x-if="order">
    <div class="space-y-4" x-data="orderSteps">
      <!-- Kopf -->
      <section class="card p-4">
        <div class="flex flex-wrap items-start gap-2">
          <div class="mr-auto min-w-0">
            <h1 class="text-xl font-semibold" x-text="supplierLabel(order)"></h1>
            <p x-show="order.origin === 'lieferschein'" class="mb-1">
              <span class="badge bg-violet-50 text-violet-800 border-violet-200">aus Lieferschein angelegt</span>
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
            <p class="hint" x-show="order.status === 'angefragt' && !order.internal_order_no">Spätestens beim Formular eintragen.</p>
            <p class="hint" x-show="order.without_internal_order_no">Ohne interne Bestellnummer bestellt (z. B. Muster).</p>
          </div>
          <div>
            <label class="label" for="supplier-order-no">Auftragsnummer des Shops <span class="font-normal text-slate-500">(optional)</span></label>
            <input id="supplier-order-no" class="input" x-model="orderForm.supplier_order_no" @change="saveOrder('supplier_order_no')" maxlength="100"
                   placeholder="aus der Bestellbestätigung">
          </div>
          <div class="sm:col-span-2">
            <label class="label" for="order-subject">Was <span class="font-normal text-slate-500">(Kurzbeschreibung, optional)</span></label>
            <input id="order-subject" class="input" x-model="orderForm.subject" @change="saveOrder('subject')" maxlength="100"
                   placeholder="z. B. Kleinteile, Messgerät">
          </div>
          <div class="sm:col-span-2">
            <label class="label">Notizen</label>
            <textarea class="input" rows="1" x-model="orderForm.notes" @change="saveOrder('notes')" maxlength="2000"></textarea>
          </div>
        </div>

        <!-- Aktionen: Module (Verwaltungsschritte werden im Ablauf abgehakt) -->
        <div class="mt-4 flex flex-wrap gap-2">
          <template x-for="p in plugins()" :key="p.id">
            <button type="button" class="btn btn-secondary" @click="runPlugin(p)" x-text="p.label"></button>
          </template>
          <template x-if="order.status === 'angefragt'">
            <button type="button" class="btn btn-danger ml-auto" :disabled="busy" @click="removeOrder()">Warenkorb löschen</button>
          </template>
        </div>
      </section>

      ${orderStepsSection}

      <!-- Positionen: am PC eine Tabelle mit einer Zeile je Gruppe (gleiche Artikelnummer zusammengefasst),
           auf Smartphone/Tablet eine kompakte Liste zum Aufklappen -->
      <section data-items>
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <h2 class="mr-auto text-lg font-semibold">
            Positionen <span class="text-sm font-normal text-slate-500" x-text="'(' + visibleItems().length + ')'"></span>
          </h2>
          <span x-show="pendingCount()" class="text-sm text-blue-700" data-pending-note>
            <span x-text="pendingCount() === 1 ? '1 Position' : pendingCount() + ' Positionen'"></span> für die Lieferung vorgemerkt …
            <button type="button" class="ml-1 font-medium underline" @click="flushPending()">Jetzt buchen</button>
          </span>
          <template x-if="canDeliver()">
            <button type="button" class="btn btn-secondary" @click="openLateForm()">Position nachtragen</button>
          </template>
          <template x-if="canDeliver()">
            <button type="button" class="btn btn-secondary" @click="openDeliveryForm()">Lieferung mit Beleg</button>
          </template>
          <template x-if="isCart()">
            <button type="button" class="btn btn-primary" @click="showItemForm = true">+ Position</button>
          </template>
        </div>

        <!-- PC -->
        <div class="card hidden overflow-x-auto lg:block" x-show="visibleItems().length">
          <table class="w-full text-sm" data-items-table>
            <thead class="text-xs text-slate-500">
              <tr>
                <th class="px-3 py-2 text-left font-semibold whitespace-nowrap">Art.-Nr.</th>
                <th class="w-full px-3 py-2 text-left font-semibold">Bezeichnung</th>
                <th class="px-3 py-2 text-left font-semibold">Gruppe</th>
                <th class="px-3 py-2 text-right font-semibold">Menge</th>
                <th class="px-3 py-2 text-right font-semibold" x-text="isCart() ? 'Gesamt' : 'Bestellt'"></th>
                <template x-if="!isCart()"><th class="px-3 py-2 text-right font-semibold">Geliefert</th></template>
                <template x-if="canDeliver()"><th class="px-3 py-2 text-left font-semibold">Lieferung</th></template>
                <template x-if="!isCart()"><th class="px-3 py-2 text-right font-semibold">Offen</th></template>
                <template x-if="isCart()"><th class="w-px"><span class="sr-only">Aktionen</span></th></template>
              </tr>
            </thead>
            <template x-for="it in visibleItems()" :key="it.id">
              <tbody class="border-t border-slate-200" data-item :data-part="it.part_number"
                     :class="isCart() && editId !== it.id && 'cursor-pointer hover:bg-slate-50'"
                     @click="isCart() && editId !== it.id && startEdit(it)">
                <template x-for="(g, gi) in groupRows(it)" :key="gi">
                  <tr>
                    <template x-if="gi === 0">
                      <td class="px-3 py-1.5 align-middle font-mono font-semibold whitespace-nowrap" :rowspan="groupRows(it).length">
                        <span x-show="editId !== it.id" x-text="it.part_number"></span>
                        <input x-show="editId === it.id" class="input w-48 py-1 font-mono" x-model="edit.part_number" maxlength="100"
                               autocapitalize="characters" spellcheck="false" aria-label="Bestellnummer des Shops" data-edit-part ${EDIT_KEYS}>
                      </td>
                    </template>
                    <template x-if="gi === 0">
                      <td class="max-w-0 px-3 py-1.5 align-middle" :rowspan="groupRows(it).length">
                        <div x-show="editId !== it.id">${NAME_TEXT}</div>
                        <input x-show="editId === it.id" class="input py-1" x-model="edit.name" maxlength="300" placeholder="Bezeichnung"
                               aria-label="Bezeichnung" ${EDIT_KEYS}>
                      </td>
                    </template>
                    <td class="px-3 py-1.5 align-middle whitespace-nowrap" :class="g.none ? 'italic text-slate-400' : 'text-slate-700'"
                        x-text="g.name || '–'" data-group></td>
                    <td class="px-3 py-1.5 text-right align-middle tabular-nums" x-text="g.qty"></td>
                    <template x-if="gi === 0">
                      <td class="px-3 py-1.5 text-right align-middle tabular-nums" :rowspan="groupRows(it).length">
                        <template x-if="isCart()">
                          <div>
                            <span x-show="editId !== it.id" x-text="it.qty_ordered"></span>
                            <input x-show="editId === it.id" type="number" min="1" step="1" class="input w-20 py-1 text-right"
                                   x-model.number="edit.qty_ordered" aria-label="Gesamtmenge" data-edit-qty ${EDIT_KEYS}>
                            <p x-show="editId === it.id && allocationSum(it) && allocationSum(it) !== edit.qty_ordered"
                               class="hint whitespace-nowrap" x-text="'Gruppen ergeben ' + allocationSum(it)"></p>
                          </div>
                        </template>
                        <template x-if="!isCart()">${ORDERED_CELL}</template>
                      </td>
                    </template>
                    <template x-if="gi === 0 && !isCart()">
                      <td class="px-3 py-1.5 text-right align-middle tabular-nums whitespace-nowrap" :rowspan="groupRows(it).length" data-delivered>
                        <span x-text="it.qty_delivered"></span><span x-show="pending[it.id]" class="ml-1 text-blue-700" x-text="'+' + pending[it.id]"></span>
                      </td>
                    </template>
                    <template x-if="gi === 0 && canDeliver()">
                      <td class="px-3 py-1 align-middle" :rowspan="groupRows(it).length">
                        <div class="flex items-center gap-2">${DELIVER_INPUT}${REST_BOX}</div>
                      </td>
                    </template>
                    <template x-if="gi === 0 && !isCart()">
                      <td class="px-3 py-1.5 text-right align-middle tabular-nums" :rowspan="groupRows(it).length" data-open>
                        <span :class="backlogOf(it) ? 'rounded bg-amber-100 px-1.5 font-semibold text-amber-900' : 'text-slate-400'"
                              x-text="backlogOf(it) || '–'"></span>
                      </td>
                    </template>
                    <template x-if="gi === 0 && isCart()">
                      <td class="px-2 py-1 align-middle whitespace-nowrap" :rowspan="groupRows(it).length" @click.stop>
                        <div x-show="editId === it.id" class="flex gap-1">
                          <button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click="saveEdit(it)" data-edit-save>Speichern</button>
                          <button type="button" class="btn btn-ghost btn-sm" @click="cancelEdit()">Abbrechen</button>
                        </div>
                        <button x-show="editId !== it.id" type="button" class="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-700"
                                @click="removeItem(it)" :aria-label="'Position ' + it.part_number + ' löschen'" x-tip="'Position löschen'"
                                data-item-delete>${TRASH}</button>
                      </td>
                    </template>
                  </tr>
                </template>
              </tbody>
            </template>
          </table>
        </div>

        <!-- Smartphone/Tablet: kompakt, Antippen klappt auf -->
        <ul class="card divide-y divide-slate-100 lg:hidden" x-show="visibleItems().length" data-items-list>
          <template x-for="it in visibleItems()" :key="it.id">
            <li data-item :data-part="it.part_number">
              <div class="flex items-center gap-3 px-3 py-2">
                <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" @click="toggleRow(it)" :aria-expanded="openRow === it.id">
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-mono text-sm font-semibold" x-text="it.part_number"></span>
                    <span class="block truncate text-xs" :class="it.name ? 'text-slate-500' : 'italic text-slate-400'" x-text="it.name || 'ohne Bezeichnung'"></span>
                  </span>
                  <span class="text-sm whitespace-nowrap tabular-nums" data-item-summary
                        x-text="isCart() ? it.qty_ordered + ' Stk.' : (it.qty_delivered + (pending[it.id] || 0)) + ' / ' + (it.qty_ordered - (it.qty_cancelled || 0))"></span>
                  ${CHEVRON}
                </button>
                <template x-if="canDeliver()">${REST_BOX}</template>
              </div>
              <div x-show="openRow === it.id" class="space-y-3 bg-slate-50 px-3 py-3 text-sm" data-item-details>
                <ul class="space-y-0.5">
                  <template x-for="(g, gi) in groupRows(it)" :key="gi">
                    <li class="flex justify-between gap-2"><span :class="g.none && 'italic text-slate-400'" x-text="g.name || 'ohne Gruppe'"></span><span class="tabular-nums" x-text="g.qty"></span></li>
                  </template>
                </ul>
                <p x-show="it.added_later_at" class="text-xs text-violet-800" x-text="'nachgetragen ' + lateLabel(it)"></p>
                <template x-if="!isCart()">
                  <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span class="flex items-center gap-1">Bestellt ${ORDERED_CELL}</span>
                    <span>Offen <span class="font-semibold" x-text="backlogOf(it)"></span></span>
                    <template x-if="canDeliver() && backlogOf(it)">
                      <span class="flex items-center gap-2">Lieferung ${DELIVER_INPUT}</span>
                    </template>
                  </div>
                </template>
                <template x-if="isCart() && editId === it.id">
                  <form class="space-y-2" @submit.prevent="saveEdit(it)">
                    <input class="input font-mono" x-model="edit.part_number" maxlength="100" aria-label="Bestellnummer des Shops"
                           autocapitalize="characters" spellcheck="false">
                    <input class="input" x-model="edit.name" maxlength="300" placeholder="Bezeichnung" aria-label="Bezeichnung">
                    <input class="input w-28" type="number" min="1" step="1" x-model.number="edit.qty_ordered" aria-label="Gesamtmenge">
                    <div class="flex gap-2">
                      <button type="submit" class="btn btn-primary" :disabled="busy">Speichern</button>
                      <button type="button" class="btn btn-danger ml-auto" @click="removeItem(it)">Löschen</button>
                    </div>
                  </form>
                </template>
              </div>
            </li>
          </template>
        </ul>
        <p x-show="!visibleItems().length" class="card p-6 text-center text-sm text-slate-500">Keine Positionen.</p>
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
                  <li class="rounded px-1.5 py-0.5 font-mono text-xs" data-delivery-line
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
    supplierLabel, statusMeta, stepMeta, backlogOf, fileUrl, fmt,
    order: null,
    items: [],
    deliveries: [],
    steps: {},
    error: '',
    busy: false,
    orderForm: {},
    editId: null,
    edit: {},
    showItemForm: false,
    /** Vorgemerkte Liefermengen je Position (werden nach DELIVERY_COLLECT_MS gemeinsam gebucht). */
    pending: {},
    pendingTimer: null,
    holding: false,
    cancelId: null,
    cancelQty: 0,
    openRow: null,
    /** Positionen, deren Löschen läuft (ausgeblendet bis „Rückgängig“ oder Ablauf). */
    hiddenItems: {},
    delivery: { open: false, qty: {}, note: '', receipt: null },
    late: { open: false, part_number: '', name: '', qty: 1, group: '', delivered: false, courses: [] },
    unsubscribe: null,

    get orderId() {
      return this.$store.route.params.id;
    },

    async init() {
      await this.reload();
      try {
        this.unsubscribe = await subscribe(['orders', 'order_items', 'deliveries', 'order_steps'], () => this.reload());
      } catch (err) {
        console.warn('Realtime nicht verfügbar', err);
      }
    },

    destroy() {
      this.unsubscribe?.();
      if (this.pendingCount()) this.flushPending();
    },

    async reload() {
      try {
        const [order, items, deliveries, steps] = await Promise.all([
          getOrder(this.orderId), listOrderItems(this.orderId), listDeliveries(this.orderId), listOrderSteps(this.orderId),
        ]);
        this.order = order;
        this.items = items;
        this.deliveries = deliveries;
        this.steps = steps;
        this.orderForm = {
          internal_order_no: order.internal_order_no || '',
          subject: order.subject || '',
          supplier_order_no: order.supplier_order_no || '',
          notes: order.notes || '',
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
    /** Warenkorb bzw. Freigabe: Positionen bearbeitbar; danach nur Storno und Lieferungen. */
    isCart() { return CART_STATUSES.includes(this.order?.status); },
    canDeliver() { return DELIVERY_STATUSES.includes(this.order?.status); },
    canCancel() { return DELIVERY_STATUSES.includes(this.order?.status); },
    visibleItems() { return this.items.filter((i) => !this.hiddenItems[i.id]); },
    /** Eine Zeile je Gruppe; ohne Aufteilung eine Zeile, nicht aufgeteilter Rest als „ohne Gruppe“. */
    groupRows(it) {
      const rows = (it.group_allocations || []).filter((a) => a.qty > 0).map((a) => ({ name: a.groupName || '', qty: a.qty }));
      if (!rows.length) return [{ name: '', qty: it.qty_ordered }];
      const rest = it.qty_ordered - rows.reduce((sum, r) => sum + r.qty, 0);
      if (rest > 0) rows.push({ name: 'ohne Gruppe', qty: rest, none: true });
      return rows;
    },
    maxCancel(it) { return Math.max(0, it.qty_ordered - (it.qty_delivered || 0)); },
    toggleRow(it) {
      if (this.openRow === it.id) {
        this.openRow = null;
        if (this.editId === it.id) this.cancelEdit();
      } else {
        this.openRow = it.id;
        if (this.isCart()) this.startEdit(it);
      }
    },
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
      try {
        this.order = { ...this.order, ...(await updateOrder(this.order.id, { [field]: value })) };
        toast.success('Gespeichert.');
      } catch (err) {
        toast.error(errorMessage(err));
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

    // ---- Positionen bearbeiten (Warenkorb): Zeile wird zur Eingabezeile ------------
    async startEdit(it) {
      if (this.editId && this.editId !== it.id) {
        const current = this.items.find((i) => i.id === this.editId);
        if (current) await this.saveEdit(current);
      }
      this.editId = it.id;
      this.edit = { part_number: it.part_number, name: it.name || '', qty_ordered: it.qty_ordered };
      this.$nextTick(() => [...document.querySelectorAll('[data-edit-part]')].find((e) => e.offsetParent)?.focus());
    },

    cancelEdit() {
      this.editId = null;
    },

    async saveEdit(it) {
      if (this.editId !== it.id) return;
      const data = { part_number: String(this.edit.part_number || '').trim(), name: String(this.edit.name || '').trim(), qty_ordered: Number(this.edit.qty_ordered) };
      if (!data.part_number) { toast.error('Die Bestellnummer des Shops fehlt.'); return; }
      if (!Number.isInteger(data.qty_ordered) || data.qty_ordered < 1) { toast.error('Die Menge muss eine ganze Zahl ab 1 sein.'); return; }
      this.editId = null;
      if (data.part_number === it.part_number && data.name === (it.name || '') && data.qty_ordered === it.qty_ordered) return;
      this.busy = true;
      try {
        await updateItem(it.id, data);
        await this.reload();
        toast.success('Position gespeichert.');
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    /** Sofort ausblenden, nach Ablauf des Toasts löschen; „Rückgängig“ blendet wieder ein. */
    async removeItem(it) {
      this.editId = null;
      this.hiddenItems = { ...this.hiddenItems, [it.id]: true };
      const show = () => { const { [it.id]: _, ...rest } = this.hiddenItems; this.hiddenItems = rest; };
      try {
        if (await deferredAction({ message: `Position ${it.part_number} gelöscht.`, run: () => deleteItem(it.id), undo: show })) {
          await this.reload();
          show();
        }
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    // ---- Storno (ab „bestellt“): Klick auf die bestellte Menge ---------------------
    startCancel(it) {
      if (!this.canCancel()) return;
      this.cancelId = it.id;
      this.cancelQty = it.qty_cancelled || 0;
    },

    async saveCancel(it) {
      if (this.cancelId !== it.id) return; // Enter und anschließendes blur
      this.cancelId = null;
      const qty = Number(this.cancelQty);
      const old = it.qty_cancelled || 0;
      if (!Number.isInteger(qty) || qty < 0 || qty > this.maxCancel(it)) {
        toast.error(`Stornierte Menge von ${it.part_number}: 0 bis ${this.maxCancel(it)}.`);
        return;
      }
      if (qty === old) return;
      try {
        await updateItem(it.id, { qty_cancelled: qty });
        await this.reload();
        toast.done(qty ? `${it.part_number}: ${qty} storniert.` : `${it.part_number}: Storno aufgehoben.`, [{
          label: 'Rückgängig',
          icon: 'undo',
          run: async () => {
            try {
              await updateItem(it.id, { qty_cancelled: old });
            } catch (err) {
              toast.error(errorMessage(err));
            }
            await this.reload();
          },
        }]);
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    // ---- Lieferungen aus der Tabelle: Menge eintragen oder Kästchen „Rest“ ------------
    pendingCount() { return Object.keys(this.pending).length; },

    setPending(it, input) {
      const raw = String(input.value).trim();
      const { [it.id]: _, ...rest } = this.pending;
      if (raw === '') {
        this.pending = rest;
        this.schedulePending();
        return;
      }
      const qty = Number(raw);
      const max = backlogOf(it);
      if (!Number.isInteger(qty) || qty < 1 || qty > max) {
        toast.error(`Liefermenge von ${it.part_number}: 1 bis ${max}.`);
        input.value = this.pending[it.id] || '';
        return;
      }
      this.pending = { ...rest, [it.id]: qty };
      this.schedulePending();
    },

    toggleRest(it) {
      const max = backlogOf(it);
      if (!max) return;
      const { [it.id]: _, ...rest } = this.pending;
      this.pending = this.pending[it.id] === max ? rest : { ...rest, [it.id]: max };
      this.schedulePending();
    },

    /** Solange ein Mengenfeld den Fokus hat, wird nicht gebucht. */
    holdPending() {
      this.holding = true;
      clearTimeout(this.pendingTimer);
    },
    releasePending() {
      this.holding = false;
      this.schedulePending();
    },
    schedulePending() {
      clearTimeout(this.pendingTimer);
      if (!this.holding && this.pendingCount()) this.pendingTimer = setTimeout(() => this.flushPending(), DELIVERY_COLLECT_MS);
    },

    async flushPending() {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      const lines = Object.entries(this.pending).map(([item, qty]) => ({ item, qty }));
      this.pending = {};
      if (!lines.length) return;
      try {
        const result = await bookDelivery(this.order.id, lines);
        await this.reload();
        toast.done(lines.length === 1 ? 'Lieferung gebucht.' : `Lieferung mit ${lines.length} Positionen gebucht.`, [{
          label: 'Rückgängig',
          icon: 'undo',
          run: async () => {
            try {
              await cancelDelivery(result.delivery.id);
            } catch (err) {
              toast.error(errorMessage(err));
            }
            await this.reload();
          },
        }]);
      } catch (err) {
        toast.error(errorMessage(err));
        await this.reload();
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
