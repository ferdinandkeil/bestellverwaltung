// Formular „Position erfassen“ – gemeinsam genutzt von Dashboard und Bestell-Detail.
// Einbinden: <div x-data="itemForm({ supplier, supplierCustomName, lockSupplier })"> ${itemFormFields} </div>
// Nach erfolgreicher Buchung wird das Event `item-added` mit { order, item, merged } ausgelöst.
import { SUPPLIERS } from '../core/config.js';
import { addItemToSupplierCart, listGroups, errorMessage } from '../core/api.js';
import { toast, numberOrNull } from '../core/ui.js';

export const itemFormFields = /* html */ `
<form @submit.prevent="submit" class="space-y-3">
  <div class="grid grid-cols-2 gap-3">
    <div :class="form.supplier === 'other' ? '' : 'col-span-2'">
      <label class="label">Lieferant</label>
      <select class="input" x-model="form.supplier" :disabled="lockSupplier" required>
        <template x-for="s in suppliers" :key="s.value">
          <option :value="s.value" x-text="s.label"></option>
        </template>
      </select>
    </div>
    <div x-show="form.supplier === 'other'">
      <label class="label">Shop-Name</label>
      <input class="input" x-model="form.supplier_custom_name" :disabled="lockSupplier"
             :required="form.supplier === 'other'" placeholder="z. B. Conrad" maxlength="100">
    </div>
  </div>

  <div>
    <label class="label">Bestellnummer des Shops</label>
    <input class="input font-mono" x-model="form.part_number" x-ref="partNumber" required maxlength="100"
           placeholder="z. B. 595-SN74HC595N" autocapitalize="characters" spellcheck="false">
    <p class="hint">Die Artikelnummer des Lieferanten, <strong>nicht</strong> die Herstellernummer.</p>
  </div>

  <div>
    <label class="label">Bezeichnung</label>
    <input class="input" x-model="form.name" required maxlength="300" placeholder="z. B. Schieberegister 8 Bit, DIP-16">
  </div>

  <div class="grid grid-cols-2 gap-3">
    <div>
      <label class="label">Menge</label>
      <input class="input" type="number" min="1" step="1" inputmode="numeric" x-model.number="form.qty" required>
    </div>
    <div>
      <label class="label">Stückpreis netto (optional)</label>
      <input class="input" type="text" inputmode="decimal" x-model="form.price_unit" placeholder="0,00">
    </div>
  </div>

  <div>
    <label class="label">Gruppe / Projekt (optional)</label>
    <select class="input" x-model="form.group">
      <option value="">– ohne Gruppe –</option>
      <template x-for="g in groups" :key="g.id">
        <option :value="g.id" x-text="g.semester ? g.name + ' (' + g.semester + ')' : g.name"></option>
      </template>
    </select>
  </div>

  <div>
    <label class="label">Link zum Artikel (optional)</label>
    <input class="input" type="url" x-model="form.url" placeholder="https://…">
  </div>

  <p x-show="error" x-text="error" class="rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>

  <div class="flex justify-end gap-2 pt-1">
    <button type="button" class="btn btn-secondary" @click="$dispatch('item-form-cancel')">Schließen</button>
    <button type="submit" class="btn btn-primary" :disabled="busy">
      <span x-text="busy ? 'Wird gebucht …' : 'In Warenkorb'"></span>
    </button>
  </div>
</form>`;

export function registerItemForm(Alpine) {
  Alpine.data('itemForm', (opts = {}) => ({
    suppliers: SUPPLIERS,
    groups: [],
    lockSupplier: !!opts.lockSupplier,
    busy: false,
    error: '',
    form: {
      supplier: opts.supplier || 'mouser',
      supplier_custom_name: opts.supplierCustomName || '',
      part_number: '',
      name: '',
      qty: 1,
      price_unit: '',
      group: '',
      url: '',
    },

    async init() {
      try {
        this.groups = await listGroups({ onlyActive: true });
      } catch (err) {
        this.error = errorMessage(err);
      }
    },

    async submit() {
      this.error = '';
      const price = numberOrNull(this.form.price_unit);
      if (this.form.price_unit !== '' && price === null) {
        this.error = 'Der Stückpreis ist keine gültige Zahl.';
        return;
      }
      this.busy = true;
      try {
        const res = await addItemToSupplierCart({
          ...this.form,
          price_unit: price,
          supplier_custom_name: this.form.supplier === 'other' ? this.form.supplier_custom_name : '',
        });
        toast.success(res.merged
          ? `Mit vorhandener Position zusammengeführt (jetzt ${res.item.qty_ordered} Stück).`
          : 'Neue Position im Sammel-Warenkorb angelegt.');
        this.$dispatch('item-added', res);
        // Lieferant und Gruppe für die nächste Eingabe behalten.
        Object.assign(this.form, { part_number: '', name: '', qty: 1, price_unit: '', url: '' });
        this.$nextTick(() => this.$refs.partNumber?.focus());
      } catch (err) {
        this.error = errorMessage(err);
      } finally {
        this.busy = false;
      }
    },
  }));
}
