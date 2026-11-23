// Bestell-Detail (ARCHITECTURE.md Kap. 7): Kopf, Ablauf, Positionen (Lieferungen und Storno in der Tabelle),
// Anhänge (inkl. Lieferschein-Belege), Plugin-Slot. Beträge werden nicht angezeigt (Kap. 4.1).
import {
  supplierLabel, statusMeta, stepMeta, groupsByCourse, INTERNAL_ORDER_NO_RE, DELIVERY_STATUSES,
} from '../core/config.js';
import {
  getOrder, listOrderItems, listDeliveries, listOrderSteps, updateOrder, deleteOrder, updateItem, deleteItem,
  bookDelivery, cancelDelivery, uploadAttachments, removeAttachment, fileUrl, backlogOf,
  subscribe, errorMessage, addLateItem, listGroups,
} from '../core/api.js';
import { getPlugins } from '../core/plugin-registry.js';
import { fmt, toast, deferredAction } from '../core/ui.js';
import { itemFormFields } from './item-form.js';
import { orderStepsSection } from './order-steps.js';
import { pdfPreview } from '../core/pdf-preview.js';

/** Phasen, in denen Positionen bearbeitet werden (vor „bestellt“); danach nur noch Storno. */
const CART_STATUSES = ['angefragt', 'freigabe'];

const TRASH = '<svg viewBox="0 0 20 20" fill="currentColor" class="size-4" aria-hidden="true"><path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.44c-.8.08-1.58.18-2.36.3a.75.75 0 1 0 .22 1.49l.15-.03.8 10.1A2.75 2.75 0 0 0 7.55 18.6h4.9a2.75 2.75 0 0 0 2.74-2.54l.8-10.1.15.03a.75.75 0 1 0 .22-1.49c-.78-.12-1.57-.22-2.36-.3v-.44A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.67.03 2.5.08v-.33c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.33C8.33 4.03 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clip-rule="evenodd"/></svg>';
const CHEVRON = '<svg viewBox="0 0 20 20" fill="currentColor" class="size-5 shrink-0 text-slate-400 transition-transform" :class="openRow === it.id && \'rotate-180\'" aria-hidden="true"><path fill-rule="evenodd" d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg>';

/**
 * Eine Zelle einer Position bearbeiten: als Text, ein Klick macht nur diese Zelle editierbar; Enter bzw. Verlassen
 * speichert (Toast mit „Rückgängig“), Escape bricht ab. Im Warenkorb Art.-Nr., Bezeichnung und Gesamtmenge,
 * ab „bestellt“ nur die stornierte Menge (Klick auf die bestellte Menge).
 */
/** Gemeinsamer Rahmen (sieht aus wie ein Eingabefeld) und das rahmenlose Feld darin. */
const FRAME_CLASS = 'input flex w-auto items-center gap-1.5 py-1 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/30';
const FRAMED_INPUT_CLASS = 'min-w-0 border-0 bg-transparent p-0 text-right text-sm text-slate-900 outline-none';

/**
 * Ganze Tabellenzelle klickbar: öffnet die Bearbeitung des Feldes (field = JS-Ausdruck), Hover über die Zelle.
 */
function cellClick(field) {
  return `@click="startCell(it, ${field})" :class="canEditCell(${field}, it) && !isEditing(it, ${field}) && 'cursor-text hover:bg-slate-50'"`;
}

function cellEdit(field, display, { input = '', align = 'left', prefix = '', suffix = '' } = {}) {
  // Ein umschließendes Element: der Baustein steht auch als einziger Inhalt eines x-if-Templates.
  return /* html */ `
<span class="${align === 'left' ? 'block' : 'inline-flex justify-end'}" data-cell-wrap>
<template x-if="!isEditing(it, '${field}')">
  <button type="button" class="max-w-full text-${align} ${align === 'left' ? 'block' : ''}" data-cell="${field}" :disabled="!canEditCell('${field}', it)"
          :class="canEditCell('${field}', it) ? 'cursor-text' : 'cursor-default'" @click.stop="startCell(it, '${field}')">${display}</button>
</template>
<template x-if="isEditing(it, '${field}')">
  <!-- Mit prefix umfasst ein gemeinsamer Rahmen Vorspann, Feld und ggf. suffix (z. B. „10 − [2]“, „30 + [5] ✓✓“). -->
  <label class="${prefix ? FRAME_CLASS : 'flex items-center gap-1'}" @click.stop>${prefix}
    <input class="${prefix ? FRAMED_INPUT_CLASS : 'input py-1 text-sm text-slate-900'} ${input}" x-model="cellValue" data-cell-input="${field}"
           x-init="$nextTick(() => { $el.focus(); $el.select(); })"
           @keydown.enter.prevent="saveCell(it)" @keydown.escape.prevent.stop="cancelCell()" @blur="saveCell(it)">${suffix}
  </label>
</template>
</span>`;
}

/** Bestellte Menge mit Storno („10 −2“); ab „bestellt“ öffnet ein Klick das Feld „storniert“. */
const ORDERED_CELL = cellEdit('qty_cancelled',
  `<span class="tabular-nums whitespace-nowrap"><span x-text="it.qty_ordered"></span><span x-show="it.qty_cancelled" class="ml-1 text-red-700" x-text="'−' + it.qty_cancelled"></span></span>`,
  {
    align: 'right',
    input: 'w-12" type="number" min="0" step="1" inputmode="numeric" aria-label="Stornierte Menge',
    // Links die ursprünglich bestellte Menge und ein rotes Minus, rechts das Feld für die stornierte Menge: „10 − [2]“
    prefix: '<span class="tabular-nums" x-text="it.qty_ordered"></span>'
      + '<svg viewBox="0 0 20 20" fill="currentColor" class="size-4 shrink-0 text-red-600" aria-hidden="true"><path fill-rule="evenodd" d="M4 10a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H4.75A.75.75 0 0 1 4 10Z" clip-rule="evenodd"/></svg>',
  });

const PLUS = '<svg viewBox="0 0 20 20" fill="currentColor" class="size-4 shrink-0 text-emerald-600" aria-hidden="true"><path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/></svg>';
/**
 * Haken „alles geliefert“, immer sichtbar: grau = noch offen (Klick bucht den ganzen Rest), grün = vollständig geliefert.
 * mousedown.prevent: im offenen Rahmen behält das Mengenfeld den Fokus, sonst schlösse blur den Rahmen vor dem Klick.
 */
const DELIVER_ALL = /* html */ `
<button type="button" class="shrink-0 rounded p-0.5" data-deliver-all x-show="canDeliver() || !backlogOf(it)"
        :class="backlogOf(it) ? 'cursor-pointer text-slate-400 hover:bg-emerald-50 hover:text-emerald-600' : 'cursor-default text-emerald-600'"
        :disabled="!backlogOf(it) || !canDeliver()" :aria-label="'Alles von ' + it.part_number + ' geliefert'"
        x-tip="backlogOf(it) ? 'Alles geliefert' : ''" @mousedown.prevent @click.stop="deliverAll(it)">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="size-5" aria-hidden="true"><path d="M4.5 12.5l5 5 10-10.5"/></svg>
</button>`;

/** Geliefert: Klick in die Zelle öffnet „Gesamtstand + [Menge dieser Lieferung] ✓“; Enter bucht sofort (Toast mit „Rückgängig“). */
const DELIVERED_CELL = cellEdit('delivered',
  `<span class="tabular-nums whitespace-nowrap" x-text="it.qty_delivered" x-tip="deliveryTip(it)"></span>`,
  {
    align: 'right',
    input: 'w-12" type="number" min="1" step="1" inputmode="numeric" :max="backlogOf(it)" placeholder="0" aria-label="Gelieferte Menge',
    prefix: `<span class="tabular-nums" x-text="it.qty_delivered"></span>${PLUS}`,
    suffix: `<span class="ml-1.5 inline-flex">${DELIVER_ALL}</span>`,
  });
/** Zelle mit immer sichtbarem Haken rechts (im offenen Rahmen sitzt er darin). */
const DELIVERED_WITH_CHECK = /* html */ `
<span class="inline-flex items-center justify-end gap-3">${DELIVERED_CELL}<span x-show="!isEditing(it, 'delivered')" class="inline-flex">${DELIVER_ALL}</span></span>`;

/** Bezeichnung (wird kaum genutzt: schmal, gekürzt, voll im Tooltip) und Kennzeichen „nachgetragen“. */
const NAME_TEXT = /* html */ `
<span class="flex min-w-0 items-center gap-1.5">
  <span class="truncate" :class="it.name ? 'text-slate-600' : 'italic text-slate-400'" x-text="it.name || 'ohne Bezeichnung'" x-tip="it.name"></span>
  <span x-show="it.added_later_at" class="badge shrink-0 border-violet-200 bg-violet-50 text-violet-800" x-tip="lateLabel(it)">nachgetragen</span>
</span>`;

/**
 * Feld im Kopf: als Text, ein Klick macht es editierbar; Enter bzw. Verlassen speichert, Escape bricht ab.
 * Bei Notizen (mehrzeilig) speichert nur das Verlassen.
 */
function headField(key, label, { id, mono = false, maxlength = 100, placeholder = '', multiline = false, attrs = '' } = {}) {
  const input = multiline
    ? `<textarea id="${id}" class="input" rows="3" maxlength="${maxlength}" x-model="orderForm.${key}" placeholder="${placeholder}"
         x-init="$nextTick(() => $el.focus())" @keydown.escape.prevent.stop="cancelField()" @blur="finishField('${key}')"></textarea>`
    : `<input id="${id}" class="input py-1 ${mono ? 'font-mono' : ''}" maxlength="${maxlength}" x-model="orderForm.${key}" placeholder="${placeholder}" ${attrs}
         x-init="$nextTick(() => { $el.focus(); $el.select(); })" @keydown.enter.prevent="finishField('${key}')"
         @keydown.escape.prevent.stop="cancelField()" @blur="finishField('${key}')">`;
  return /* html */ `
<div class="min-w-0" data-field="${key}">
  <label class="label" for="${id}">${label}</label>
  <template x-if="editField !== '${key}'">
    <button type="button" class="-mx-1 block max-w-full rounded px-1 py-0.5 text-left ${mono ? 'font-mono' : ''}"
            :class="isClosed() ? 'cursor-default' : 'cursor-text hover:bg-slate-100'" :disabled="isClosed()"
            @click="startField('${key}')" data-field-value>
      <span x-show="order.${key}" class="break-words whitespace-pre-wrap" x-text="order.${key}"></span>
      <span x-show="!order.${key}" class="text-slate-400">–</span>
    </button>
  </template>
  <template x-if="editField === '${key}'">${input}</template>
</div>`;
}

const PART_CELL = cellEdit('part_number', '<span x-text="it.part_number"></span>',
  { input: 'w-48 font-mono" maxlength="100" autocapitalize="characters" spellcheck="false" aria-label="Bestellnummer des Shops' });
const NAME_CELL = cellEdit('name', NAME_TEXT, { input: 'w-full" maxlength="300" placeholder="Bezeichnung" aria-label="Bezeichnung' });
const QTY_CELL = cellEdit('qty_ordered', '<span class="tabular-nums" x-text="it.qty_ordered"></span>',
  { align: 'right', input: 'w-20 text-right" type="number" min="1" step="1" inputmode="numeric" aria-label="Gesamtmenge' });

const template = /* html */ `
<div x-data="orderDetailView" @order-steps-changed.window="$event.detail.orderId === orderId && reload()">
  <a href="#/" class="mb-3 inline-block text-sm text-blue-700 hover:underline">← Alle Bestellungen</a>

  <p x-show="error" x-text="error" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>
  <p x-show="!order && !error" class="py-8 text-center text-sm text-slate-500">Lade …</p>

  <template x-if="order">
    <div class="space-y-4" x-data="orderSteps">
      <!-- Kopf: Lieferant, Phase und Nummern kompakt; Felder als Text, ein Klick macht sie editierbar -->
      <section class="card p-4" data-order-head>
        <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div class="mr-auto min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h1 class="text-xl font-semibold" x-text="supplierLabel(order)"></h1>
              <span class="badge text-sm" data-status-badge :class="statusMeta(order.status).badge" x-text="statusMeta(order.status).label"></span>
              <span x-show="order.origin === 'lieferschein'" class="badge border-violet-200 bg-violet-50 text-violet-800">aus Lieferschein angelegt</span>
            </div>
            <p class="mt-1.5 text-xs text-slate-500">
              Angelegt <span x-text="fmt.dateTime(order.created)"></span>
              <span x-show="order.expand?.created_by" x-text="'von ' + (order.expand?.created_by?.name || order.expand?.created_by?.email)"></span>
            </p>
          </div>
          <!-- Aktionen: Module (Verwaltungsschritte werden im Ablauf abgehakt) -->
          <div class="flex flex-wrap gap-2">
            <template x-for="p in plugins()" :key="p.id">
              <button type="button" class="btn btn-secondary btn-sm" @click="runPlugin(p)" x-text="p.label"></button>
            </template>
            <template x-if="order.status === 'angefragt'">
              <button type="button" class="btn btn-danger btn-sm" :disabled="busy" @click="removeOrder()">Warenkorb löschen</button>
            </template>
          </div>
        </div>

        <div class="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-[minmax(9rem,auto)_minmax(9rem,auto)_minmax(9rem,auto)_1fr]">
          <div>
            ${headField('internal_order_no', 'Interne Bestellnummer', { id: 'internal-order-no', mono: true, maxlength: 11, placeholder: 'z. B. 2026IW01047', attrs: 'autocapitalize="characters" spellcheck="false"' })}
            <p class="hint" x-show="order.status === 'angefragt' && !order.internal_order_no">Spätestens beim Formular eintragen.</p>
            <p class="hint" x-show="order.without_internal_order_no">Ohne interne Bestellnummer bestellt (z. B. Muster).</p>
          </div>
          ${headField('supplier_order_no', 'Auftragsnummer des Shops', { id: 'supplier-order-no', placeholder: 'aus der Bestellbestätigung' })}
          ${headField('subject', 'Was', { id: 'order-subject', placeholder: 'z. B. Kleinteile, Messgerät' })}
          ${headField('notes', 'Notizen', { id: 'order-notes', maxlength: 2000, multiline: true })}
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
                <template x-if="!isCart()"><th class="px-3 py-2 text-right font-semibold">Offen</th></template>
                <template x-if="isCart()"><th class="w-px"><span class="sr-only">Aktionen</span></th></template>
              </tr>
            </thead>
            <template x-for="it in visibleItems()" :key="it.id">
              <tbody class="border-t border-slate-200" data-item :data-part="it.part_number">
                <template x-for="(g, gi) in groupRows(it)" :key="gi">
                  <tr>
                    <template x-if="gi === 0">
                      <td class="px-3 py-1.5 align-middle font-mono font-semibold whitespace-nowrap" :rowspan="groupRows(it).length" ${cellClick("'part_number'")}>
                        ${PART_CELL}
                      </td>
                    </template>
                    <template x-if="gi === 0">
                      <td class="max-w-0 px-3 py-1.5 align-middle" :rowspan="groupRows(it).length" ${cellClick("'name'")}>
                        ${NAME_CELL}
                      </td>
                    </template>
                    <td class="px-3 py-1.5 align-middle whitespace-nowrap" :class="g.none ? 'italic text-slate-400' : 'text-slate-700'"
                        x-text="g.name || '–'" data-group></td>
                    <td class="px-3 py-1.5 text-right align-middle tabular-nums" x-text="g.qty"></td>
                    <template x-if="gi === 0">
                      <td class="px-3 py-1.5 text-right align-middle tabular-nums" :rowspan="groupRows(it).length"
                          ${cellClick("isCart() ? 'qty_ordered' : 'qty_cancelled'")} data-ordered-cell>
                        <template x-if="isCart()">
                          <div class="flex flex-col items-end">
                            ${QTY_CELL}
                            <p x-show="isEditing(it, 'qty_ordered') && allocationSum(it) && allocationSum(it) !== Number(cellValue)"
                               class="hint whitespace-nowrap" x-text="'Gruppen ergeben ' + allocationSum(it)"></p>
                          </div>
                        </template>
                        <template x-if="!isCart()">${ORDERED_CELL}</template>
                      </td>
                    </template>
                    <template x-if="gi === 0 && !isCart()">
                      <td class="px-3 py-1.5 text-right align-middle whitespace-nowrap" :rowspan="groupRows(it).length"
                          ${cellClick("'delivered'")} data-delivered>${DELIVERED_WITH_CHECK}</td>
                    </template>
                    <template x-if="gi === 0 && !isCart()">
                      <td class="px-3 py-1.5 text-right align-middle tabular-nums" :rowspan="groupRows(it).length" data-open>
                        <span :class="backlogOf(it) ? 'rounded bg-amber-100 px-1.5 font-semibold text-amber-900' : 'text-slate-400'"
                              x-text="backlogOf(it) || '–'"></span>
                      </td>
                    </template>
                    <template x-if="gi === 0 && isCart()">
                      <td class="px-2 py-1 align-middle whitespace-nowrap" :rowspan="groupRows(it).length">
                        <button type="button" class="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-700"
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
                        x-text="isCart() ? it.qty_ordered + ' Stk.' : it.qty_delivered + ' / ' + (it.qty_ordered - (it.qty_cancelled || 0))"></span>
                  ${CHEVRON}
                </button>
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
                    <span class="flex items-center gap-1">Geliefert ${DELIVERED_WITH_CHECK}</span>
                  </div>
                </template>
                <template x-if="isCart()">
                  <dl class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
                    <dt class="text-slate-500">Art.-Nr.</dt><dd class="min-w-0 font-mono">${PART_CELL}</dd>
                    <dt class="text-slate-500">Bezeichnung</dt><dd class="min-w-0">${NAME_CELL}</dd>
                    <dt class="text-slate-500">Menge</dt><dd>${QTY_CELL}</dd>
                  </dl>
                </template>
                <template x-if="isCart()">
                  <button type="button" class="btn btn-danger btn-sm" @click="removeItem(it)">Position löschen</button>
                </template>
              </div>
            </li>
          </template>
        </ul>
        <p x-show="!visibleItems().length" class="card p-6 text-center text-sm text-slate-500">Keine Positionen.</p>
      </section>

      <!-- Anhänge: eigene Dateien der Bestellung und die Lieferschein-Belege der Lieferbuchungen (gespeichert an der
           Buchung, hier nur angezeigt, nicht löschbar). Eine eigene Lieferhistorie gibt es nicht (Tooltip an „Geliefert“). -->
      <section class="card p-4" data-attachments>
        <div class="flex items-center gap-2">
          <!-- Standardmäßig eingeklappt; Vorschauen (auch PDF, erste Seite) werden erst beim Aufklappen geladen -->
          <button type="button" class="mr-auto flex items-center gap-1 text-left" @click="toggleAttachments()"
                  :aria-expanded="attachmentsOpen" data-attachments-toggle>
            <h2 class="text-lg font-semibold">Anhänge <span class="text-sm font-normal text-slate-500" x-text="'(' + attachmentEntries().length + ')'"></span></h2>
            <svg viewBox="0 0 20 20" fill="currentColor" class="size-5 shrink-0 text-slate-400 transition-transform" :class="attachmentsOpen && 'rotate-180'" aria-hidden="true"><path fill-rule="evenodd" d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg>
          </button>
          <label class="btn btn-secondary btn-sm cursor-pointer" x-show="!isClosed()">
            Datei hinzufügen
            <input type="file" class="hidden" multiple accept="image/jpeg,image/png,image/webp,application/pdf" @change="upload($event)">
          </label>
        </div>
        <ul class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" x-show="attachmentsOpen && attachmentEntries().length">
          <template x-for="a in attachmentEntries()" :key="a.key">
            <li class="relative overflow-hidden rounded-lg border border-slate-200" :data-attachment="a.kind">
              <a :href="a.url" target="_blank" rel="noopener" class="block">
                <template x-if="!a.pdf">
                  <img :src="a.thumb" :alt="a.label" class="aspect-square w-full object-cover" loading="lazy">
                </template>
                <template x-if="a.pdf && pdfThumbs[a.key]">
                  <img :src="pdfThumbs[a.key]" :alt="a.label" class="aspect-square w-full bg-white object-cover object-top" data-pdf-thumb>
                </template>
                <template x-if="a.pdf && !pdfThumbs[a.key]">
                  <div class="flex aspect-square items-center justify-center bg-slate-50 text-sm font-semibold text-slate-500">PDF</div>
                </template>
                <div class="truncate px-2 py-1 text-xs" x-text="a.label" x-tip="a.title"></div>
              </a>
              <button type="button" class="absolute right-1 top-1 rounded bg-white/90 px-1.5 text-xs text-red-700 shadow" x-show="a.file && !isClosed()"
                      @click="removeFile(a.file)" aria-label="Anhang löschen" data-attachment-delete>✕</button>
            </li>
          </template>
        </ul>
        <p x-show="attachmentsOpen && !attachmentEntries().length" class="mt-3 text-sm text-slate-500">Noch keine Anhänge.</p>
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
    /** Feld im Kopf, das gerade bearbeitet wird. */
    editField: null,
    /** Zelle in Bearbeitung: { id, field } und ihr Eingabewert. */
    editCell: null,
    cellValue: '',
    showItemForm: false,
    openRow: null,
    /** Positionen, deren Löschen läuft (ausgeblendet bis „Rückgängig“ oder Ablauf). */
    hiddenItems: {},
    hiddenFiles: {},
    attachmentsOpen: false,
    /** Vorschaubilder der PDFs (Object-URLs) je Eintrag; fehlt eins, bleibt die Kachel „PDF“. */
    pdfThumbs: {},
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
    },

    async reload() {
      try {
        const [order, items, deliveries, steps] = await Promise.all([
          getOrder(this.orderId), listOrderItems(this.orderId), listDeliveries(this.orderId), listOrderSteps(this.orderId),
        ]);
        this.order = order;
        this.items = items;
        this.deliveries = deliveries;
        if (this.attachmentsOpen) this.$nextTick(() => this.loadPdfThumbs());
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
    /** Abgeschlossen: alles nur lesbar (wieder öffnen über den Ablauf). */
    isClosed() { return this.order?.status === 'abgeschlossen'; },
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
      } else {
        this.openRow = it.id;
      }
    },
    allocationSum(it) { return (it.group_allocations || []).reduce((s, a) => s + (a.qty || 0), 0); },

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
    startField(key) {
      if (this.isClosed()) return;
      this.orderForm[key] = this.order[key] || '';
      this.editField = key;
    },
    cancelField() {
      if (this.editField) this.orderForm[this.editField] = this.order[this.editField] || '';
      this.editField = null;
    },
    /** Enter bzw. Verlassen: speichern, wenn sich etwas geändert hat (Enter und anschließendes blur nur einmal). */
    async finishField(key) {
      if (this.editField !== key) return;
      this.editField = null;
      const value = String(this.orderForm[key] ?? '').trim();
      if (value === (this.order[key] || '')) return;
      if (!(await this.saveOrder(key))) this.orderForm[key] = this.order[key] || '';
    },

    async saveOrder(field) {
      let value = this.orderForm[field];
      if (field === 'internal_order_no') {
        value = value.trim().toUpperCase();
        this.orderForm.internal_order_no = value;
        if (value && !INTERNAL_ORDER_NO_RE.test(value)) {
          toast.error('Die interne Bestellnummer hat das Format JJJJIW##### (z. B. 2026IW01047).');
          return false;
        }
      }
      if (typeof value === 'string') value = value.trim();
      try {
        this.order = { ...this.order, ...(await updateOrder(this.order.id, { [field]: value })) };
        toast.success('Gespeichert.');
        return true;
      } catch (err) {
        toast.error(errorMessage(err));
        return false;
      }
    },

    /** Warenkorb sofort verlassen und nach Ablauf des Toasts löschen; „Rückgängig“ führt zurück. */
    async removeOrder() {
      const id = this.order.id;
      const name = supplierLabel(this.order);
      location.hash = '#/';
      try {
        await deferredAction({
          message: `Warenkorb ${name} gelöscht.`,
          run: () => deleteOrder(id),
          undo: () => { location.hash = '#/orders/' + id; },
        });
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    // ---- Positionen: eine Zelle bearbeiten (Warenkorb: Art.-Nr., Bezeichnung, Menge; ab „bestellt“: Storno) ----
    canEditCell(field, it) {
      if (field === 'delivered') return this.canDeliver() && backlogOf(it) > 0;
      return field === 'qty_cancelled' ? this.canCancel() : this.isCart();
    },
    isEditing(it, field) {
      return this.editCell?.id === it.id && this.editCell.field === field;
    },
    startCell(it, field) {
      if (!this.canEditCell(field, it)) return;
      this.editCell = { id: it.id, field };
      this.cellValue = field === 'delivered' ? '' : field === 'qty_cancelled' ? (it.qty_cancelled || 0) : (it[field] ?? '');
    },
    cancelCell() {
      this.editCell = null;
    },

    /** Prüfen und speichern; Enter und das anschließende blur speichern nur einmal. */
    async saveCell(it) {
      if (this.editCell?.id !== it.id) return;
      const { field } = this.editCell;
      this.editCell = null;
      const raw = String(this.cellValue ?? '').trim();
      if (field === 'delivered') return this.saveDelivered(it, raw);
      const old = field === 'qty_cancelled' ? (it.qty_cancelled || 0) : (it[field] ?? '');
      let value = raw;
      if (field === 'part_number' && !raw) { toast.error('Die Bestellnummer des Shops darf nicht leer sein.'); return; }
      if (field === 'qty_ordered' || field === 'qty_cancelled') {
        value = Number(raw);
        const [min, max] = field === 'qty_ordered' ? [1, Infinity] : [0, this.maxCancel(it)];
        if (raw === '' || !Number.isInteger(value) || value < min || value > max) {
          toast.error(field === 'qty_ordered' ? 'Die Menge muss eine ganze Zahl ab 1 sein.'
            : `Stornierte Menge von ${it.part_number}: 0 bis ${max}.`);
          return;
        }
      }
      if (value === old) return;
      const message = field === 'qty_cancelled'
        ? (value ? `${it.part_number}: ${value} storniert.` : `${it.part_number}: Storno aufgehoben.`)
        : `${{ part_number: 'Bestellnummer', name: 'Bezeichnung', qty_ordered: 'Menge' }[field]} von ${it.part_number} gespeichert.`;
      try {
        await updateItem(it.id, { [field]: value });
        await this.reload();
        toast.done(message, [{
          label: 'Rückgängig',
          icon: 'undo',
          run: async () => {
            try {
              await updateItem(it.id, { [field]: old });
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

    /** Sofort ausblenden, nach Ablauf des Toasts löschen; „Rückgängig“ blendet wieder ein. */
    async removeItem(it) {
      this.editCell = null;
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

    // ---- Lieferung in der Zelle „Geliefert“: sofort buchen, „Rückgängig“ nimmt die Buchung zurück ----------
    async saveDelivered(it, raw) {
      if (raw === '') return;
      const qty = Number(raw);
      const max = backlogOf(it);
      if (!Number.isInteger(qty) || qty < 1 || qty > max) {
        toast.error(`Liefermenge von ${it.part_number}: 1 bis ${max}.`);
        return;
      }
      await this.bookLine(it, qty);
    },

    /** Haken „alles geliefert“: den ganzen Rest der Position buchen. */
    async deliverAll(it) {
      this.editCell = null;
      const max = backlogOf(it);
      if (max > 0) await this.bookLine(it, max);
    },

    async bookLine(it, qty) {
      try {
        const result = await bookDelivery(this.order.id, [{ item: it.id, qty }]);
        await this.reload();
        toast.done(`Lieferung gebucht: ${it.part_number} +${qty}.`, [{
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
        this.attachmentsOpen = true; // das Neue soll sichtbar sein
        await this.reload();
        toast.success(files.length === 1 ? 'Anhang hochgeladen.' : `${files.length} Anhänge hochgeladen.`);
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    visibleAttachments() { return (this.order?.attachments || []).filter((f) => !this.hiddenFiles[f]); },

    toggleAttachments() {
      this.attachmentsOpen = !this.attachmentsOpen;
      if (this.attachmentsOpen) this.loadPdfThumbs();
    },

    /** PDF-Vorschauen der sichtbaren Anhänge nachladen (nur wenn aufgeklappt). */
    loadPdfThumbs() {
      for (const a of this.attachmentEntries()) {
        if (!a.pdf || this.pdfThumbs[a.key]) continue;
        pdfPreview(a.url).then((src) => { this.pdfThumbs = { ...this.pdfThumbs, [a.key]: src }; })
          .catch((err) => console.warn('PDF-Vorschau nicht möglich', a.label, err));
      }
    },

    /** Lieferschein-Belege (an den Buchungen) und eigene Anhänge der Bestellung in einer Liste. */
    attachmentEntries() {
      const isPdf = (f) => f.toLowerCase().endsWith('.pdf');
      const receipts = this.deliveries.filter((d) => d.receipt).map((d) => ({
        key: 'r-' + d.id, kind: 'receipt', file: null, pdf: isPdf(d.receipt),
        url: fileUrl(d, d.receipt), thumb: fileUrl(d, d.receipt, '200x200'),
        label: 'Lieferschein ' + fmt.date(d.created), title: d.note || '',
      }));
      const own = this.visibleAttachments().map((f) => ({
        key: 'a-' + f, kind: 'file', file: f, pdf: isPdf(f),
        url: fileUrl(this.order, f), thumb: fileUrl(this.order, f, '200x200'), label: f, title: '',
      }));
      return [...receipts, ...own];
    },

    /** Tooltip an „Geliefert“: Datum und Menge je Buchung, z. B. „23.11. +30 · 25.11. +20“. */
    deliveryTip(it) {
      const parts = [];
      for (const d of [...this.deliveries].sort((x, y) => x.created.localeCompare(y.created))) {
        for (const line of d.expand?.delivery_items_via_delivery ?? []) {
          if (line.order_item !== it.id) continue;
          const day = new Date(d.created.replace(' ', 'T')).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
          parts.push(`${day} ${line.qty > 0 ? '+' : ''}${line.qty}`);
        }
      }
      return parts.join(' · ');
    },

    /** Anhang sofort ausblenden, nach Ablauf des Toasts löschen; „Rückgängig“ blendet wieder ein. */
    async removeFile(name) {
      this.hiddenFiles = { ...this.hiddenFiles, [name]: true };
      const show = () => { const { [name]: _, ...rest } = this.hiddenFiles; this.hiddenFiles = rest; };
      const orderId = this.order.id;
      try {
        if (await deferredAction({ message: `Anhang „${name}“ gelöscht.`, run: () => removeAttachment(orderId, name), undo: show })) {
          if (this.order?.id === orderId) await this.reload();
          show();
        }
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
  };
}

export default { dataName: 'orderDetailView', template, component };
