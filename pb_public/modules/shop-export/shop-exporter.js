// Shop-Export: offener Warenkorb → CSV für den Upload im Shop bzw. Liste für die Bestell-Mail
// → „Exportiert & auf ‚Bestellt‘ setzen“.
// Registriert sich im Slot 'order-detail-actions' (nur Status „angefragt“ und Lieferanten mit Format, formats.js).
// Der Statuswechsel läuft über die Status-Route; die Detailansicht aktualisiert sich per Realtime.
import Alpine from '../../vendor/alpinejs@3.17.5/dist/module.esm.js';
import { registerPlugin } from '../../core/plugin-registry.js';
import { INTERNAL_ORDER_NO_RE, defaultWithoutInternalOrderNo } from '../../core/config.js';
import { changeOrderStatus, listOrderItems, errorMessage } from '../../core/api.js';
import { toast, confirmAction } from '../../core/ui.js';
import { formatForOrder, exportLines, buildCsv, buildText, csvFileName, sameLines } from './formats.js';

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

      <ul class="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 text-sm" data-export-lines>
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
          <span x-text="format?.kind === 'text'
            ? 'Der Warenkorb wurde seit dem Kopieren geändert. Bitte die Liste prüfen, neu kopieren und die Mail abgleichen.'
            : 'Der Warenkorb wurde seit dem Download geändert. Bitte die Liste prüfen, neu herunterladen und im Shop abgleichen.'"></span>
        </p>
        <button type="button" class="btn btn-primary" :disabled="busy || !exported" @click="markOrdered()" data-export-ordered>
          Exportiert &amp; auf „Bestellt“ setzen
        </button>
        <p x-show="!exported" class="hint" x-text="format?.kind === 'text' ? 'Erst nach dem Kopieren möglich.' : 'Erst nach dem Download möglich.'"></p>
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
        if (!sameLines(this.lines, this.exported)) {
          this.changed = true;
          this.exported = null;
          return;
        }
        if (!(await confirmAction(
          (without ? 'Warenkorb ohne interne Bestellnummer als bestellt markieren?' : 'Warenkorb als bestellt markieren?') +
          ' Neue Positionen für diesen Lieferanten landen danach in einem neuen Warenkorb.',
          { confirmLabel: 'Als bestellt markieren' }))) return;
        const supplierNo = this.supplierNo.trim();
        await changeOrderStatus(this.order.id, 'advance', without
          ? { without_internal_order_no: true, supplier_order_no: supplierNo }
          : { internal_order_no: internal, supplier_order_no: supplierNo });
        toast.success('Status: Bestellt');
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

registerPlugin({
  id: 'shop-export',
  slot: 'order-detail-actions',
  label: 'Shop-Export',
  icon: 'download',
  isVisible: (order) => order?.status === 'angefragt' && !!formatForOrder(order),
  // Kopien übergeben: die Werte der Detailansicht sind reaktive Proxies einer anderen Komponente.
  onClick: (order, items) => window.dispatchEvent(new CustomEvent('open-shop-export', {
    detail: { order: JSON.parse(JSON.stringify(order)), items: JSON.parse(JSON.stringify(items)) },
  })),
});
