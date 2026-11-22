// Shop-Export: Bestellung in Freigabe (bzw. Warenkorb ohne Formular, z. B. Würth-Muster) → CSV für den Upload im Shop,
// Liste für die Bestell-Mail bzw. Abhakliste zum Übertragen von Hand → „Exportiert & auf ‚Bestellt‘ setzen“.
// Der Stand der Abhakliste liegt nur in diesem Browser (localStorage je Bestellung).
// Registriert sich im Slot 'order-detail-actions' (nur Lieferanten mit Format, formats.js; Sichtbarkeit: exportVisible).
// „Bestellt“ läuft über die Schritt-Route (ARCHITECTURE Kap. 4.3); die Detailansicht aktualisiert sich per Realtime.
import Alpine from '../../vendor/alpinejs@3.17.5/dist/module.esm.js';
import { registerPlugin } from '../../core/plugin-registry.js';
import { INTERNAL_ORDER_NO_RE, defaultWithoutInternalOrderNo } from '../../core/config.js';
import { setOrderStep, listOrderItems, errorMessage } from '../../core/api.js';
import { toast, confirmAction } from '../../core/ui.js';
import {
  formatForOrder, exportLines, buildCsv, buildText, csvFileName, sameLines,
  emptyChecklist, parseChecklist, checklistState, toggleChecklist, checklistComplete, checklistRemoved, forgetChecklistPart,
} from './formats.js';

const CHECKLIST_KEY = 'shop-export-checklist:';

function loadChecklist(orderId) {
  try { return parseChecklist(localStorage.getItem(CHECKLIST_KEY + orderId)); } catch (_) { return emptyChecklist(); }
}

function saveChecklist(orderId, state) {
  try {
    if (state) localStorage.setItem(CHECKLIST_KEY + orderId, JSON.stringify(state));
    else localStorage.removeItem(CHECKLIST_KEY + orderId);
  } catch (_) { /* ohne Speicher gilt der Stand nur, solange das Fenster offen ist */ }
}

const template = /* html */ `
<div x-data="shopExporter" @open-shop-export.window="open($event.detail)" x-cloak>
  <div x-show="isOpen" x-transition.opacity class="modal-backdrop" @click.self="close()" @keydown.escape.window="isOpen && close()">
    <div class="modal-panel space-y-4" data-shop-export>
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold" x-text="'Export für ' + (format?.label || '')"></h2>
          <p class="text-xs text-slate-500" x-text="lines.length + ' Position(en)' + (skipped ? ' · ' + skipped + ' komplett storniert, nicht enthalten' : '')"></p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" @click="close()">Schließen</button>
      </div>

      <ul x-show="format?.kind !== 'checklist'" class="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 text-sm" data-export-lines>
        <template x-for="l in lines" :key="l.id">
          <li class="flex items-baseline gap-3 px-3 py-1.5">
            <span class="w-12 shrink-0 text-right font-medium tabular-nums" x-text="l.qty + '×'"></span>
            <span class="min-w-0 flex-1">
              <span class="block break-all font-mono" x-text="l.part"></span>
              <span class="block truncate text-xs text-slate-500" x-text="l.name || 'ohne Bezeichnung'"></span>
            </span>
          </li>
        </template>
      </ul>

      <section x-show="format?.kind === 'csv'" class="space-y-2">
        <h3 class="text-sm font-semibold">1. Datei herunterladen und im Shop hochladen</h3>
        <p class="text-xs text-slate-500">Im Shop den CSV-Upload der Schnellbestellung nutzen und den Warenkorb dort prüfen.</p>
        <button type="button" class="btn btn-primary" :disabled="!lines.length" @click="download()" data-export-download>CSV herunterladen</button>
        <p x-show="exported" class="text-xs text-emerald-700" x-text="'Heruntergeladen: ' + fileName"></p>
      </section>

      <section x-show="format?.kind === 'text'" class="space-y-2">
        <h3 class="text-sm font-semibold">1. Liste kopieren und per Mail bestellen</h3>
        <p class="text-xs text-slate-500" x-text="'Liste in die Bestell-Mail an ' + (format?.recipient || '') + ' einfügen (je Zeile Menge × Artikelnummer).'"></p>
        <button type="button" class="btn btn-primary" :disabled="!lines.length" @click="copy()" data-export-copy>Liste kopieren</button>
        <p x-show="exported && !manualCopy" class="text-xs text-emerald-700">In die Zwischenablage kopiert.</p>
        <div x-show="manualCopy" class="space-y-1">
          <p class="text-xs text-amber-800">Kopieren war nicht möglich. Bitte den markierten Text von Hand kopieren.</p>
          <textarea x-ref="copyText" class="input font-mono" readonly rows="4" :value="text" @focus="$el.select()"></textarea>
        </div>
      </section>

      <section x-show="format?.kind === 'checklist'" class="space-y-2" data-export-checklist>
        <h3 class="text-sm font-semibold">1. Positionen in den Shop-Warenkorb übertragen</h3>
        <p class="text-xs text-slate-500">
          Je Position die Artikelnummer kopieren, bei
          <a :href="format?.shopUrl" target="_blank" rel="noopener" class="text-blue-700 underline">„Bestellen mit Artikelnummer“</a>
          einfügen und hinzufügen, dann die Menge im Shop-Warenkorb einstellen. Beides abhaken.
        </p>
        <p class="text-xs font-medium" :class="complete ? 'text-emerald-700' : 'text-slate-600'" data-checklist-progress
           x-text="rows.filter((r) => r.partDone).length + '/' + rows.length + ' Artikelnummern · ' + rows.filter((r) => r.qtyDone).length + '/' + rows.length + ' Mengen'"></p>
        <div x-show="removed.length" class="space-y-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-900" data-checklist-removed>
          <p>Nicht mehr im Warenkorb – bitte im Shop-Warenkorb wieder entfernen:</p>
          <template x-for="p in removed" :key="p">
            <div class="flex items-center gap-2">
              <span class="flex-1 break-all font-mono" x-text="p"></span>
              <button type="button" class="btn btn-ghost btn-sm" @click="forget(p)">Entfernt</button>
            </div>
          </template>
        </div>
        <ul class="max-h-[50vh] divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 text-sm">
          <template x-for="l in rows" :key="l.id">
            <li class="flex items-center gap-2 px-2 py-2" :class="current === l.id ? 'bg-blue-50' : ''" :data-checklist-row="l.part">
              <label class="flex w-10 shrink-0 cursor-pointer flex-col items-center gap-0.5 text-[10px] text-slate-500">
                <input type="checkbox" class="size-5" :checked="l.partDone" @change="toggle(l, 'part', $event.target.checked)" data-check-part>
                Nr.
              </label>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="break-all font-mono select-all" x-text="l.part" data-part></span>
                  <button type="button" class="btn btn-ghost btn-sm shrink-0" @click="copyPart(l, $el)" data-copy-part
                          x-text="current === l.id && !copyFailed ? 'Kopiert' : 'Kopieren'"></button>
                </div>
                <span class="block truncate text-xs text-slate-500" x-text="l.name || 'ohne Bezeichnung'"></span>
              </div>
              <span class="w-12 shrink-0 text-right font-semibold tabular-nums" x-text="l.qty + '×'"></span>
              <label class="flex w-12 shrink-0 cursor-pointer flex-col items-center gap-0.5 text-[10px] text-slate-500">
                <input type="checkbox" class="size-5" :checked="l.qtyDone" @change="toggle(l, 'qty', $event.target.checked)" data-check-qty>
                Menge
              </label>
            </li>
          </template>
        </ul>
      </section>

      <section class="space-y-3 border-t border-slate-200 pt-3">
        <h3 class="text-sm font-semibold" x-text="format?.kind === 'text' ? '2. Nach dem Senden der Mail' : '2. Nach dem Bestellen im Shop'"></h3>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="label" for="export-internal-no">Interne Bestellnummer</label>
            <input id="export-internal-no" class="input font-mono" x-model="internalNo" maxlength="11" placeholder="z. B. 2026IW01047"
                   autocapitalize="characters" spellcheck="false" @change="internalNo = internalNo.trim().toUpperCase()"
                   :disabled="withoutInternalNo">
            <label class="mt-2 flex items-center gap-2 text-sm" data-export-without-internal-no>
              <input type="checkbox" x-model="withoutInternalNo" :disabled="!!order?.internal_order_no">
              ohne interne Bestellnummer (z. B. Muster)
            </label>
          </div>
          <div>
            <label class="label" for="export-supplier-no">Auftragsnummer des Shops <span class="font-normal text-slate-500">(optional)</span></label>
            <input id="export-supplier-no" class="input" x-model="supplierNo" maxlength="100" placeholder="aus der Bestellbestätigung">
          </div>
        </div>
        <p x-show="changed" class="rounded-lg bg-amber-50 p-2 text-xs text-amber-900" data-export-changed>
          <span x-text="format?.kind === 'checklist'
            ? 'Der Warenkorb wurde inzwischen geändert. Bitte die offenen Haken in der Liste erledigen.'
            : format?.kind === 'text'
            ? 'Der Warenkorb wurde seit dem Kopieren geändert. Bitte die Liste prüfen, neu kopieren und die Mail abgleichen.'
            : 'Der Warenkorb wurde seit dem Download geändert. Bitte die Liste prüfen, neu herunterladen und im Shop abgleichen.'"></span>
        </p>
        <button type="button" class="btn btn-primary" :disabled="busy || !ready" @click="markOrdered()" data-export-ordered>
          Exportiert &amp; auf „Bestellt“ setzen
        </button>
        <p x-show="!ready" class="hint" x-text="{
          checklist: 'Erst möglich, wenn bei allen Positionen Artikelnummer und Menge abgehakt sind.',
          text: 'Erst nach dem Kopieren möglich.',
        }[format?.kind] || 'Erst nach dem Download möglich.'"></p>
      </section>
    </div>
  </div>
</div>`;

function component() {
  return {
    isOpen: false,
    busy: false,
    order: null,
    format: null,
    lines: [],
    skipped: 0,
    exported: null, // Positionen der zuletzt heruntergeladenen Datei bzw. kopierten Liste
    fileName: '',
    text: '',
    manualCopy: false,
    withoutInternalNo: false,
    changed: false,
    internalNo: '',
    supplierNo: '',
    check: emptyChecklist(), // Abhakliste
    current: null, // zuletzt kopierte Position
    copyFailed: false,

    get rows() { return checklistState(this.lines, this.check); },
    get removed() { return checklistRemoved(this.lines, this.check); },
    get complete() { return checklistComplete(this.lines, this.check) && !this.removed.length; },
    /** „Exportiert & bestellt“ freigegeben? */
    get ready() { return this.format?.kind === 'checklist' ? this.complete : !!this.exported; },

    open({ order, items }) {
      this.order = order;
      this.format = formatForOrder(order);
      this.setItems(items);
      this.exported = null;
      this.manualCopy = false;
      this.changed = false;
      this.internalNo = order.internal_order_no || '';
      this.withoutInternalNo = defaultWithoutInternalOrderNo(order);
      this.supplierNo = order.supplier_order_no || '';
      this.check = this.format?.kind === 'checklist' ? loadChecklist(order.id) : emptyChecklist();
      this.current = null;
      this.isOpen = true;
    },

    close() { this.isOpen = false; },

    setItems(items) {
      const { lines, skipped } = exportLines(items);
      this.lines = lines;
      this.skipped = skipped;
    },

    download() {
      this.fileName = csvFileName(this.format, { ...this.order, internal_order_no: this.internalNo });
      const blob = new Blob([buildCsv(this.format, this.lines)], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = this.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Verzögert freigeben: manche Browser (iOS Safari) lesen die Datei erst nach dem Klick.
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      this.exported = this.lines.map((l) => ({ ...l }));
      this.changed = false;
    },

    async copy() {
      this.text = buildText(this.lines);
      const lines = this.lines.map((l) => ({ ...l }));
      try {
        await navigator.clipboard.writeText(this.text);
        this.manualCopy = false;
      } catch (_) {
        // Ohne Zwischenablage-Zugriff (z. B. ältere Browser): Text markiert anzeigen
        this.manualCopy = true;
        await this.$nextTick();
        this.$refs.copyText.focus();
      }
      this.exported = lines;
      this.changed = false;
    },

    toggle(line, which, done) {
      this.check = toggleChecklist(this.check, line, which, done);
      saveChecklist(this.order.id, this.check);
      this.changed = false;
    },

    forget(part) {
      this.check = forgetChecklistPart(this.check, part);
      saveChecklist(this.order.id, this.check);
    },

    async copyPart(line, button) {
      this.current = line.id;
      try {
        await navigator.clipboard.writeText(line.part);
        this.copyFailed = false;
      } catch (_) {
        // Ohne Zwischenablage-Zugriff: Nummer markieren, damit sie von Hand kopiert werden kann
        const el = button.closest('li').querySelector('[data-part]');
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        this.copyFailed = true;
        toast.error('Kopieren war nicht möglich. Die Nummer ist markiert – bitte von Hand kopieren.');
      }
    },

    async markOrdered() {
      const without = this.withoutInternalNo;
      const internal = this.internalNo.trim().toUpperCase();
      this.internalNo = internal;
      if (!without && !INTERNAL_ORDER_NO_RE.test(internal)) {
        toast.error('Bitte die interne Bestellnummer eintragen (Format JJJJIW#####, z. B. 2026IW01047) oder „ohne interne Bestellnummer“ wählen.');
        document.getElementById('export-internal-no')?.focus();
        return;
      }
      this.busy = true;
      try {
        // Andere Nutzer können während des Bestellens Positionen ergänzen: nur setzen, wenn die Datei noch stimmt.
        this.setItems(await listOrderItems(this.order.id));
        if (this.format.kind === 'checklist' ? !this.complete : !sameLines(this.lines, this.exported)) {
          this.changed = true;
          this.exported = null;
          return;
        }
        const cart = this.order.status === 'angefragt';
        if (!(await confirmAction(
          (without ? 'Ohne interne Bestellnummer als bestellt markieren?' : 'Als bestellt markieren?') +
          (cart
            ? ' Der Warenkorb wird damit geschlossen; neue Positionen für diesen Lieferanten landen in einem neuen Warenkorb.'
            : ' Noch offene Formularschritte gelten danach als übersprungen.'),
          { confirmLabel: 'Als bestellt markieren' }))) return;
        const supplierNo = this.supplierNo.trim();
        await setOrderStep(this.order.id, 'ordered', without
          ? { without_internal_order_no: true, supplier_order_no: supplierNo }
          : { internal_order_no: internal, supplier_order_no: supplierNo });
        toast.success('Status: Bestellt');
        if (this.format.kind === 'checklist') saveChecklist(this.order.id, null);
        this.isOpen = false;
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },
  };
}

// ---- Einhängen ----------------------------------------------------------------
Alpine.data('shopExporter', component);
const host = document.createElement('div');
host.innerHTML = template;
document.body.appendChild(host.firstElementChild);

/**
 * Sichtbar, sobald die Freigabe läuft (Phase „freigabe“ – Bestellung kommt nach Formular und Freigabe), oder schon im
 * Warenkorb, wenn ohne interne Bestellnummer und damit ohne Formular bestellt wird (Würth-Muster).
 */
export function exportVisible(order) {
  if (!order || !formatForOrder(order)) return false;
  return order.status === 'freigabe' || (order.status === 'angefragt' && defaultWithoutInternalOrderNo(order));
}

registerPlugin({
  id: 'shop-export',
  slot: 'order-detail-actions',
  label: 'Shop-Export',
  icon: 'download',
  isVisible: exportVisible,
  // Kopien übergeben: die Werte der Detailansicht sind reaktive Proxies einer anderen Komponente.
  onClick: (order, items) => window.dispatchEvent(new CustomEvent('open-shop-export', {
    detail: { order: JSON.parse(JSON.stringify(order)), items: JSON.parse(JSON.stringify(items)) },
  })),
});
