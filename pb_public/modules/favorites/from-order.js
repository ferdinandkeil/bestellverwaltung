// Favoriten: Positionen einer Bestellung in eine Favoritenliste übernehmen (ARCHITECTURE.md Kap. 4.7).
// Registriert sich im Slot 'order-detail-actions' (jede Bestellung mit Positionen, unabhängig vom Status).
// Ziel: eine eigene Liste desselben Lieferanten oder eine neue Liste; die Übernahme läuft über die Route
// POST /api/lab/favorite-lists/from-order (alles oder nichts).
import Alpine from '../../vendor/alpinejs@3.17.5/dist/module.esm.js';
import { registerPlugin } from '../../core/plugin-registry.js';
import { supplierLabel } from '../../core/config.js';
import { listOwnFavoriteLists, addFavoritesFromOrder, errorMessage } from '../../core/api.js';
import { toast } from '../../core/ui.js';

const template = /* html */ `
<div x-data="favoritesFromOrder" @open-favorites-from-order.window="open($event.detail)" x-cloak>
  <div x-show="isOpen" x-transition.opacity class="modal-backdrop" @click.self="close()" @keydown.escape.window="isOpen && close()">
    <div class="modal-panel space-y-4" data-favorites-from-order>
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <h2 class="text-base font-semibold">In Favoriten übernehmen</h2>
          <p class="text-xs text-slate-500" x-text="supplierLabel(order) + ' · ' + items.length + ' Position(en)'"></p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" @click="close()">Schließen</button>
      </div>

      <template x-if="!result">
        <form class="space-y-4" @submit.prevent="submit()">
          <section class="space-y-1">
            <label class="flex items-center gap-2 border-b border-slate-100 pb-1.5 text-sm text-slate-600">
              <input type="checkbox" class="size-4" :checked="selected.length === items.length" @change="selected = $event.target.checked ? items.map((i) => i.id) : []" data-fav-all>
              alle Positionen
            </label>
            <ul class="max-h-64 divide-y divide-slate-100 overflow-y-auto text-sm">
              <template x-for="it in items" :key="it.id">
                <li>
                  <label class="flex cursor-pointer items-start gap-2 py-1.5" :data-fav-item="it.part_number">
                    <input type="checkbox" class="mt-0.5 size-4 shrink-0" :value="it.id" x-model="selected">
                    <span class="min-w-0 flex-1">
                      <span class="block break-all font-mono" x-text="it.part_number"></span>
                      <span class="block truncate text-xs text-slate-500" x-text="it.name || 'ohne Bezeichnung'"></span>
                    </span>
                    <span class="shrink-0 text-xs text-slate-500" x-text="'Standard ' + defaultQty(it) + '×'"></span>
                  </label>
                </li>
              </template>
            </ul>
          </section>

          <section class="space-y-2">
            <h3 class="text-sm font-semibold">Ziel</h3>
            <label x-show="lists.length" class="flex items-center gap-2 text-sm">
              <input type="radio" value="existing" x-model="target"> in eigene Liste
            </label>
            <select x-show="lists.length && target === 'existing'" class="input" x-model="listId" aria-label="Favoritenliste">
              <template x-for="l in lists" :key="l.id"><option :value="l.id" x-text="l.title"></option></template>
            </select>
            <label x-show="lists.length" class="flex items-center gap-2 text-sm">
              <input type="radio" value="new" x-model="target"> neue Liste
            </label>
            <p x-show="!lists.length" class="text-xs text-slate-500" x-text="'Sie haben noch keine Favoritenliste für ' + supplierLabel(order) + ' – es wird eine neue angelegt.'"></p>
            <div x-show="target === 'new'" class="space-y-2">
              <div>
                <label class="label" for="fav-new-title">Titel</label>
                <input id="fav-new-title" class="input" x-model="newList.title" maxlength="150" :required="target === 'new'"
                       placeholder="z. B. Grundausstattung Praktikum">
              </div>
              <div>
                <label class="label" for="fav-new-description">Beschreibung <span class="font-normal text-slate-500">(optional)</span></label>
                <textarea id="fav-new-description" class="input" rows="2" x-model="newList.description" maxlength="1000"></textarea>
              </div>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" x-model="newList.is_public"> öffentlich</label>
            </div>
          </section>

          <p class="hint">Artikel, die schon in der Liste stehen, werden nicht doppelt angelegt; fehlende Angaben und der Preis werden ergänzt.</p>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn btn-secondary" @click="close()">Abbrechen</button>
            <button type="submit" class="btn btn-primary" :disabled="busy || !selected.length" data-fav-submit
                    x-text="selected.length + ' Artikel übernehmen'"></button>
          </div>
        </form>
      </template>

      <template x-if="result">
        <div class="space-y-3" data-fav-result>
          <p class="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900" x-text="resultText()"></p>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn btn-secondary" @click="close()">Schließen</button>
            <a class="btn btn-primary" :href="'#/favorites/' + result.list.id" @click="close()">Zur Liste</a>
          </div>
        </div>
      </template>
    </div>
  </div>
</div>`;

function component() {
  return {
    supplierLabel,
    isOpen: false,
    busy: false,
    order: null,
    items: [],
    selected: [],
    lists: [],
    target: 'new',
    listId: '',
    newList: { title: '', description: '', is_public: false },
    result: null,

    async open({ order, items }) {
      this.order = order;
      this.items = items;
      this.selected = items.map((i) => i.id);
      this.result = null;
      this.newList = { title: '', description: '', is_public: false };
      this.lists = [];
      this.target = 'new';
      this.isOpen = true;
      try {
        const shop = (order.supplier_custom_name || '').trim().toLowerCase();
        this.lists = (await listOwnFavoriteLists(order.supplier))
          .filter((l) => order.supplier !== 'other' || l.supplier_custom_name.toLowerCase() === shop);
        if (this.lists.length) {
          this.target = 'existing';
          this.listId = this.lists[0].id;
        }
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    close() { this.isOpen = false; },

    defaultQty(it) { return Math.max(1, (it.qty_ordered || 0) - (it.qty_cancelled || 0)); },

    async submit() {
      const body = { order: this.order.id };
      if (this.selected.length !== this.items.length) body.items = [...this.selected];
      if (this.target === 'existing') {
        body.list = this.listId;
      } else {
        const title = this.newList.title.trim();
        if (!title) {
          toast.error('Bitte einen Titel für die neue Liste angeben.');
          return;
        }
        body.new_list = { ...this.newList, title };
      }
      this.busy = true;
      try {
        this.result = await addFavoritesFromOrder(body);
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    resultText() {
      const r = this.result;
      const parts = [`${r.added} Artikel in „${r.list.title}“ übernommen.`];
      if (r.existing) parts.push(`${r.existing} stand(en) schon in der Liste` + (r.priceUpdated ? `, ${r.priceUpdated} Preis(e) aktualisiert.` : '.'));
      return parts.join(' ');
    },
  };
}

// ---- Einhängen ----------------------------------------------------------------
Alpine.data('favoritesFromOrder', component);
const host = document.createElement('div');
host.innerHTML = template;
document.body.appendChild(host.firstElementChild);

registerPlugin({
  id: 'favorites-from-order',
  slot: 'order-detail-actions',
  label: 'In Favoriten',
  icon: 'star',
  isVisible: (order, items) => !!order && (items?.length ?? 0) > 0,
  // Kopien übergeben: die Werte der Detailansicht sind reaktive Proxies einer anderen Komponente.
  onClick: (order, items) => window.dispatchEvent(new CustomEvent('open-favorites-from-order', {
    detail: { order: JSON.parse(JSON.stringify(order)), items: JSON.parse(JSON.stringify(items)) },
  })),
});
