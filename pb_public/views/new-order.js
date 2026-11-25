// „+ Neue Bestellung“ (ARCHITECTURE.md Kap. 4.8): Bestellung von Hand übernehmen, z. B. außerhalb des
// Systems bestellt. Knopf rechts unter der Tabelle der Startseite (ab 640 px; auf dem Smartphone wird nur gescannt),
// Maske mit Lieferant, Stand, interner Bestellnummer und Positionen → Route POST /api/lab/orders/manual.
import { SUPPLIERS, INTERNAL_ORDER_NO_RE, groupsByCourse } from '../core/config.js';
import { createManualOrder, listGroups, errorMessage } from '../core/api.js';
import { toast } from '../core/ui.js';

/** Wählbare Stände (Reihenfolge = Ablauf); ohne interne Bestellnummer erst ab „Bestellt“ (kein Formular). */
const STAGES = [
  { value: 'form_written', label: 'Formular geschrieben' },
  { value: 'form_signed', label: 'Formular unterschrieben' },
  { value: 'form_submitted', label: 'Formular in Verwaltung' },
  { value: 'approval', label: 'Freigabe' },
  { value: 'ordered', label: 'Bestellt', withoutAllowed: true },
  { value: 'delivered', label: 'Geliefert (alles)', withoutAllowed: true },
];

let rowKey = 0;
const emptyRow = () => ({ key: ++rowKey, part_number: '', name: '', qty: 1, group: '' });
const isEmpty = (r) => !r.part_number.trim() && !r.name.trim();

export const newOrderSection = /* html */ `
<div x-data="newOrder" data-new-order>
  <div class="mt-3 hidden justify-end sm:flex">
    <button type="button" class="btn btn-primary" @click="open()" data-new-order-button>+ Neue Bestellung</button>
  </div>

  <div x-show="isOpen" x-cloak x-transition.opacity class="modal-backdrop" @click.self="close()" @keydown.escape.window="isOpen && close()">
    <form class="modal-panel space-y-4 sm:max-w-3xl" @submit.prevent="submit()" novalidate data-new-order-form>
      <div>
        <h2 class="text-lg font-semibold">Neue Bestellung</h2>
        <p class="text-sm text-slate-600">Bestellung von Hand übernehmen, z. B. außerhalb des Systems bestellt. Erledigte Schritte erscheinen ohne Datum und lassen sich im Ablauf nachtragen.</p>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label" for="new-order-supplier">Lieferant</label>
          <select id="new-order-supplier" class="input" x-model="form.supplier" @change="supplierChanged()">
            <template x-for="s in suppliers" :key="s.value"><option :value="s.value" x-text="s.label" :selected="s.value === form.supplier"></option></template>
          </select>
        </div>
        <div x-show="form.supplier === 'other'">
          <label class="label" for="new-order-shop">Shop-Name</label>
          <input id="new-order-shop" class="input" x-model="form.supplier_custom_name" maxlength="100" placeholder="z. B. Conrad">
        </div>
        <div>
          <label class="label" for="new-order-stage">Stand</label>
          <select id="new-order-stage" class="input" x-model="form.stage" @change="stageChanged()">
            <template x-for="s in stages" :key="s.value"><option :value="s.value" x-text="s.label" :selected="s.value === form.stage"></option></template>
          </select>
          <p class="hint">Alle Schritte bis hierhin gelten als erledigt.</p>
        </div>
        <div>
          <label class="label" for="new-order-number">Interne Bestellnummer</label>
          <input id="new-order-number" class="input font-mono" x-model="form.internal_order_no" maxlength="11" placeholder="2026IW01047"
                 spellcheck="false" autocomplete="off" :disabled="form.without_internal_order_no">
          <label class="mt-1 flex items-center gap-2 text-sm" :class="!withoutAllowed() && 'text-slate-400'">
            <input type="checkbox" x-model="form.without_internal_order_no" :disabled="!withoutAllowed()"
                   @change="form.without_internal_order_no && (form.internal_order_no = '')" data-new-order-without>
            ohne interne Bestellnummer (Muster, Direktkauf – ab „Bestellt“)
          </label>
        </div>
        <div>
          <label class="label" for="new-order-shop-no">Auftragsnr. des Shops <span class="font-normal text-slate-500">(optional)</span></label>
          <input id="new-order-shop-no" class="input" x-model="form.supplier_order_no" maxlength="100">
        </div>
        <div>
          <label class="label" for="new-order-subject">Was <span class="font-normal text-slate-500">(optional)</span></label>
          <input id="new-order-subject" class="input" x-model="form.subject" maxlength="200" placeholder="z. B. Kleinteile">
        </div>
      </div>

      <div>
        <h3 class="mb-1 text-sm font-semibold">Positionen</h3>
        <table class="w-full text-sm" data-new-order-items>
          <thead class="text-left text-xs text-slate-500">
            <tr><th class="pb-1 font-normal">Art.-Nr.</th><th class="pb-1 font-normal">Bezeichnung</th>
                <th class="w-20 pb-1 font-normal">Menge</th><th class="pb-1 font-normal">Gruppe</th><th class="w-8"></th></tr>
          </thead>
          <tbody>
            <template x-for="(r, i) in form.items" :key="r.key">
              <tr :data-new-order-row="i" @keydown.enter.prevent="enterInRow(i)">
                <td class="py-0.5 pr-1"><input class="input font-mono" x-model="r.part_number" maxlength="100" spellcheck="false"
                       :aria-label="'Art.-Nr. Position ' + (i + 1)" data-field="part_number"></td>
                <td class="py-0.5 pr-1"><input class="input" x-model="r.name" maxlength="300" :aria-label="'Bezeichnung Position ' + (i + 1)"></td>
                <td class="py-0.5 pr-1"><input class="input text-right" type="number" min="1" step="1" x-model.number="r.qty"
                       :aria-label="'Menge Position ' + (i + 1)" data-field="qty"></td>
                <td class="py-0.5 pr-1">
                  <select class="input" x-model="r.group" :aria-label="'Gruppe Position ' + (i + 1)">
                    <option value="">– ohne Gruppe –</option>
                    <template x-for="c in groupCourses" :key="c.label">
                      <optgroup :label="c.label">
                        <template x-for="g in c.groups" :key="g.id"><option :value="g.id" x-text="g.name"></option></template>
                      </optgroup>
                    </template>
                  </select>
                </td>
                <td class="py-0.5 text-right">
                  <button type="button" class="rounded p-1 text-slate-400 hover:text-red-700" @click="removeRow(i)"
                          :aria-label="'Position ' + (i + 1) + ' entfernen'">✕</button>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <button type="button" class="btn btn-ghost btn-sm mt-1" @click="addRow()">+ Position</button>
        <p class="hint">Enter springt in eine neue Zeile. Leere Zeilen werden ignoriert, gleiche Art.-Nr. zusammengefasst.</p>
      </div>

      <p x-show="error" x-text="error" class="rounded-lg bg-red-50 p-3 text-sm text-red-700" data-new-order-error></p>

      <div class="flex flex-wrap justify-end gap-2 pt-1">
        <button type="button" class="btn btn-secondary" @click="close()">Abbrechen</button>
        <button type="submit" class="btn btn-primary" :disabled="busy" x-text="busy ? 'Wird angelegt …' : 'Bestellung anlegen'"></button>
      </div>
    </form>
  </div>
</div>`;

export function registerNewOrder(Alpine) {
  Alpine.data('newOrder', () => ({
    isOpen: false,
    busy: false,
    error: '',
    suppliers: SUPPLIERS,
    stages: STAGES,
    groupCourses: [],
    form: null,

    init() {
      this.form = this.blank();
    },

    blank() {
      return {
        supplier: 'reichelt', supplier_custom_name: '', stage: 'ordered', internal_order_no: '',
        without_internal_order_no: false, supplier_order_no: '', subject: '', items: [emptyRow()],
      };
    },

    async open() {
      this.form = this.blank();
      this.error = '';
      this.isOpen = true;
      this.$nextTick(() => document.getElementById('new-order-supplier')?.focus());
      if (!this.groupCourses.length) {
        try {
          this.groupCourses = groupsByCourse(await listGroups({ onlyActive: true }));
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }
    },

    close() {
      this.isOpen = false;
    },

    withoutAllowed() {
      return !!STAGES.find((s) => s.value === this.form.stage)?.withoutAllowed;
    },

    /** Würth (Muster): „ohne interne Bestellnummer“ vorausgewählt, sofern der Stand es zulässt und keine Nummer steht. */
    supplierChanged() {
      const preset = !!SUPPLIERS.find((s) => s.value === this.form.supplier)?.withoutInternalOrderNo;
      this.form.without_internal_order_no = preset && this.withoutAllowed() && !this.form.internal_order_no.trim();
    },

    stageChanged() {
      if (!this.withoutAllowed()) this.form.without_internal_order_no = false;
    },

    addRow() {
      this.form.items.push(emptyRow());
      const i = this.form.items.length - 1;
      this.$nextTick(() => this.$root.querySelector(`[data-new-order-row="${i}"] [data-field=part_number]`)?.focus());
    },

    /** Enter in einer Zeile: zur nächsten Zeile (in der letzten eine neue anlegen), Cursor in die Art.-Nr. */
    enterInRow(i) {
      if (i === this.form.items.length - 1) {
        if (isEmpty(this.form.items[i])) return;
        this.addRow();
        return;
      }
      this.$root.querySelector(`[data-new-order-row="${i + 1}"] [data-field=part_number]`)?.focus();
    },

    removeRow(i) {
      this.form.items.splice(i, 1);
      if (!this.form.items.length) this.form.items.push(emptyRow());
    },

    /** Prüft die Eingaben vorab (der Server prüft dasselbe noch einmal). → Fehlermeldung oder '' */
    validate(items) {
      const f = this.form;
      if (f.supplier === 'other' && !f.supplier_custom_name.trim()) return 'Bitte den Shop-Namen angeben.';
      const no = f.internal_order_no.trim().toUpperCase();
      if (!f.without_internal_order_no) {
        if (!no) return this.withoutAllowed()
          ? 'Bitte die interne Bestellnummer angeben oder „ohne interne Bestellnummer“ wählen.'
          : 'Bitte die interne Bestellnummer angeben.';
        if (!INTERNAL_ORDER_NO_RE.test(no)) return 'Die interne Bestellnummer hat das Format JJJJIW##### (z. B. 2026IW01047).';
      }
      if (!items.length) return 'Bitte mindestens eine Position erfassen.';
      const bad = items.findIndex((r) => !r.part_number || !Number.isInteger(r.qty) || r.qty < 1);
      if (bad >= 0) return `Position ${bad + 1}: Art.-Nr. und eine Menge ab 1 angeben.`;
      return '';
    },

    async submit() {
      const f = this.form;
      const items = f.items.filter((r) => !isEmpty(r))
        .map((r) => ({ part_number: r.part_number.trim(), name: r.name.trim(), qty: Number(r.qty), group: r.group }));
      this.error = this.validate(items);
      if (this.error) return;
      this.busy = true;
      try {
        const r = await createManualOrder({
          supplier: f.supplier,
          supplier_custom_name: f.supplier === 'other' ? f.supplier_custom_name.trim() : '',
          stage: f.stage,
          ...(f.without_internal_order_no ? { without_internal_order_no: true } : { internal_order_no: f.internal_order_no.trim() }),
          supplier_order_no: f.supplier_order_no.trim(),
          subject: f.subject.trim(),
          items,
        });
        this.isOpen = false;
        toast.success('Bestellung angelegt.');
        location.hash = '#/orders/' + r.order.id;
      } catch (err) {
        this.error = errorMessage(err);
      } finally {
        this.busy = false;
      }
    },
  }));
}
