// Favoriten: eine Liste (ARCHITECTURE.md Kap. 4.7).
// Alle können ansehen und daraus bestellen; Liste und Artikel bearbeitet nur der Besitzer.
// „In den Warenkorb“ bucht die ausgewählten Artikel über den Sammel-Import (alles oder nichts).
import { supplierLabel, groupsByCourse } from '../core/config.js';
import {
  getFavoriteList, listFavoriteItems, updateFavoriteList, deleteFavoriteList, createFavoriteItem, updateFavoriteItem,
  deleteFavoriteItem, listGroups, addItemsToCarts, findOpenCart, subscribe, errorMessage,
} from '../core/api.js';
import { fmt, toast, confirmAction, numberOrNull } from '../core/ui.js';

const monthYear = new Intl.DateTimeFormat('de-DE', { month: '2-digit', year: 'numeric' });

function emptyItem() {
  return { part_number: '', name: '', qty: 1, price_unit: '', url: '' };
}

/** Sortierung: nach Bezeichnung, Artikel ohne Bezeichnung nach Bestellnummer. */
function sortItems(items) {
  return items.sort((a, b) => (a.name || a.part_number).localeCompare(b.name || b.part_number, 'de', { numeric: true }));
}

const template = /* html */ `
<div x-data="favoriteListView">
  <a href="#/favorites" class="mb-3 inline-block text-sm text-blue-700 hover:underline">← Alle Favoriten</a>

  <p x-show="error" x-text="error" class="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>

  <template x-if="list">
    <div class="space-y-4">
      <section class="card p-4">
        <div class="flex flex-wrap items-start gap-2">
          <div class="min-w-0 flex-1">
            <h1 class="text-xl font-semibold" x-text="list.title" data-favorite-title></h1>
            <p class="text-sm text-slate-600" x-text="supplierLabel(list) + ' · ' + (isOwner() ? 'eigene Liste' : 'von ' + ownerName())"></p>
          </div>
          <span x-show="list.is_public" class="badge bg-emerald-50 text-emerald-700 ring-emerald-300">öffentlich</span>
          <span x-show="!list.is_public" class="badge bg-slate-100 text-slate-600 ring-slate-300">nicht öffentlich</span>
          <button x-show="isOwner()" type="button" class="btn btn-secondary btn-sm" @click="startEditList()">Bearbeiten</button>
        </div>
        <p x-show="list.description" class="mt-2 whitespace-pre-line text-sm text-slate-700" x-text="list.description"></p>
        <p x-show="!isOwner()" class="hint mt-2">Nur der Besitzer kann die Liste ändern. Bestellen können alle.</p>
      </section>

      <section class="card p-4">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <h2 class="mr-auto text-base font-semibold" x-text="'Artikel (' + items.length + ')'"></h2>
          <button x-show="isOwner()" type="button" class="btn btn-secondary btn-sm" @click="startItem()">+ Artikel</button>
        </div>
        <p x-show="!items.length" class="text-sm text-slate-500">
          Noch keine Artikel. Artikel aus einer Bestellung übernehmen („In Favoriten“ in der Bestellung)<span x-show="isOwner()"> oder von Hand hinzufügen</span>.
        </p>
        <label x-show="items.length" class="flex items-center gap-2 border-b border-slate-100 pb-2 text-sm text-slate-600">
          <input type="checkbox" class="size-4" :checked="allSelected()" @change="selectAll($event.target.checked)" data-select-all>
          alle auswählen
        </label>
        <ul class="divide-y divide-slate-100">
          <template x-for="it in items" :key="it.id">
            <li class="flex items-start gap-3 py-2" :data-favorite-item="it.part_number">
              <input type="checkbox" class="mt-1 size-5 shrink-0" :checked="selected.includes(it.id)" @change="toggle(it.id, $event.target.checked)"
                     :aria-label="'Auswählen: ' + (it.name || it.part_number)">
              <div class="min-w-0 flex-1">
                <div class="text-sm" :class="it.name ? 'font-medium' : 'italic text-slate-500'" x-text="it.name || 'ohne Bezeichnung'"></div>
                <div class="break-all font-mono text-sm" x-text="it.part_number"></div>
                <div class="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
                  <span x-text="'Standardmenge ' + it.qty"></span>
                  <span x-show="it.price_unit" x-text="priceText(it)"></span>
                  <a x-show="it.url" :href="it.url" target="_blank" rel="noopener" class="text-blue-700 underline">Link</a>
                </div>
              </div>
              <button x-show="isOwner()" type="button" class="btn btn-ghost btn-sm shrink-0" @click="startItem(it)">Bearbeiten</button>
            </li>
          </template>
        </ul>
      </section>

      <!-- Leiste zum Bestellen (auf dem Smartphone unten fixiert) -->
      <div x-show="selected.length" class="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:rounded-xl sm:border sm:p-3">
        <div class="mx-auto flex max-w-6xl items-center gap-2">
          <span class="mr-auto text-sm" x-text="selected.length + ' ausgewählt'"></span>
          <button type="button" class="btn btn-ghost btn-sm" @click="selected = []">Auswahl aufheben</button>
          <button type="button" class="btn btn-primary" @click="startCart()" data-to-cart>In den Warenkorb …</button>
        </div>
      </div>
    </div>
  </template>

  <!-- Modal: in den Warenkorb -->
  <div x-show="cart.open" x-transition.opacity class="modal-backdrop" @click.self="cart.open = false"
       @keydown.escape.window="cart.open && (cart.open = false)">
    <form class="modal-panel space-y-3" @submit.prevent="submitCart()" data-cart-form>
      <h2 class="text-lg font-semibold">In den Warenkorb legen</h2>
      <p class="text-xs text-slate-500" x-text="'Die Artikel kommen in den offenen Sammel-Warenkorb von ' + supplierLabel(list) + '. Die Favoritenliste bleibt unverändert.'"></p>
      <div>
        <label class="label" for="cart-group-all">Gruppe / Projekt für alle</label>
        <select id="cart-group-all" class="input" x-model="cart.groupAll" @change="applyGroupAll()">
          <option value="">– ohne Gruppe –</option>
          <template x-for="c in courses" :key="c.label">
            <optgroup :label="c.label">
              <template x-for="g in c.groups" :key="g.id"><option :value="g.id" x-text="g.name"></option></template>
            </optgroup>
          </template>
        </select>
        <p class="hint">Gilt für alle Zeilen; einzelne Zeilen lassen sich darunter abweichend wählen.</p>
      </div>
      <ul class="space-y-2">
        <template x-for="row in cart.rows" :key="row.id">
          <li class="rounded-lg border border-slate-200 p-2" :data-cart-row="row.part_number">
            <div class="text-sm font-medium" x-text="row.name || row.part_number"></div>
            <div x-show="row.name" class="break-all font-mono text-xs text-slate-500" x-text="row.part_number"></div>
            <div class="mt-1.5 grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
              <input class="input text-right" type="number" min="1" step="1" inputmode="numeric" x-model.number="row.qty" required aria-label="Menge">
              <select class="input" x-model="row.group" aria-label="Gruppe">
                <option value="">– ohne Gruppe –</option>
                <template x-for="c in courses" :key="c.label">
                  <optgroup :label="c.label">
                    <template x-for="g in c.groups" :key="g.id"><option :value="g.id" x-text="g.name"></option></template>
                  </optgroup>
                </template>
              </select>
            </div>
          </li>
        </template>
      </ul>
      <div class="flex justify-end gap-2 pt-1">
        <button type="button" class="btn btn-secondary" @click="cart.open = false">Abbrechen</button>
        <button type="submit" class="btn btn-primary" :disabled="busy" x-text="busy ? 'Wird gebucht …' : cart.rows.length + ' Artikel in den Warenkorb'"></button>
      </div>
    </form>
  </div>

  <!-- Modal: Artikel anlegen/bearbeiten (Besitzer) -->
  <div x-show="itemForm.open" x-transition.opacity class="modal-backdrop" @click.self="itemForm.open = false"
       @keydown.escape.window="itemForm.open && (itemForm.open = false)">
    <form class="modal-panel space-y-3" @submit.prevent="saveItem()" data-favorite-item-form>
      <h2 class="text-lg font-semibold" x-text="itemForm.id ? 'Artikel bearbeiten' : 'Artikel hinzufügen'"></h2>
      <div>
        <label class="label" for="fav-part">Bestellnummer des Shops</label>
        <input id="fav-part" class="input font-mono" x-model="itemForm.data.part_number" x-ref="part" required maxlength="100"
               autocapitalize="characters" spellcheck="false">
        <p class="hint">Die Artikelnummer des Lieferanten, <strong>nicht</strong> die Herstellernummer.</p>
      </div>
      <div>
        <label class="label" for="fav-name">Bezeichnung <span class="font-normal text-slate-500">(empfohlen)</span></label>
        <input id="fav-name" class="input" x-model="itemForm.data.name" maxlength="300">
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label" for="fav-qty">Standardmenge</label>
          <input id="fav-qty" class="input" type="number" min="1" step="1" inputmode="numeric" x-model.number="itemForm.data.qty" required>
        </div>
        <div>
          <label class="label" for="fav-price">Stückpreis netto (optional)</label>
          <input id="fav-price" class="input" type="text" inputmode="decimal" x-model="itemForm.data.price_unit" placeholder="0,00">
        </div>
      </div>
      <div>
        <label class="label" for="fav-url">Link zum Artikel (optional)</label>
        <input id="fav-url" class="input" type="url" x-model="itemForm.data.url" placeholder="https://…">
      </div>
      <div class="flex flex-wrap gap-2 pt-1">
        <button x-show="itemForm.id" type="button" class="btn btn-danger" @click="removeItem()">Entfernen</button>
        <button type="button" class="btn btn-secondary ml-auto" @click="itemForm.open = false">Abbrechen</button>
        <button type="submit" class="btn btn-primary" :disabled="busy">Speichern</button>
      </div>
    </form>
  </div>

  <!-- Modal: Liste bearbeiten (Besitzer) -->
  <div x-show="listForm.open" x-transition.opacity class="modal-backdrop" @click.self="listForm.open = false"
       @keydown.escape.window="listForm.open && (listForm.open = false)">
    <form class="modal-panel space-y-3" @submit.prevent="saveList()" data-favorite-list-edit>
      <h2 class="text-lg font-semibold">Liste bearbeiten</h2>
      <div>
        <label class="label" for="fav-edit-title">Titel</label>
        <input id="fav-edit-title" class="input" x-model="listForm.data.title" required maxlength="150">
      </div>
      <div x-show="list?.supplier === 'other'">
        <label class="label" for="fav-edit-shop">Shop-Name</label>
        <input id="fav-edit-shop" class="input" x-model="listForm.data.supplier_custom_name" maxlength="100" :required="list?.supplier === 'other'">
      </div>
      <div>
        <label class="label" for="fav-edit-description">Beschreibung <span class="font-normal text-slate-500">(optional)</span></label>
        <textarea id="fav-edit-description" class="input" rows="3" x-model="listForm.data.description" maxlength="1000"></textarea>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" x-model="listForm.data.is_public"> öffentlich (erscheint bei allen im voreingestellten Filter)
      </label>
      <div class="flex flex-wrap gap-2 pt-1">
        <button type="button" class="btn btn-danger" @click="removeList()">Liste löschen</button>
        <button type="button" class="btn btn-secondary ml-auto" @click="listForm.open = false">Abbrechen</button>
        <button type="submit" class="btn btn-primary" :disabled="busy">Speichern</button>
      </div>
    </form>
  </div>
</div>`;

function component() {
  return {
    supplierLabel,
    list: null,
    items: [],
    selected: [],
    courses: [],
    error: '',
    busy: false,
    cart: { open: false, groupAll: '', rows: [] },
    itemForm: { open: false, id: null, data: emptyItem() },
    listForm: { open: false, data: {} },
    unsubscribe: null,

    async init() {
      await this.reload();
      try {
        this.unsubscribe = await subscribe(['favorite_lists', 'favorite_items'], () => this.reload());
      } catch (err) {
        console.warn('Realtime nicht verfügbar', err);
      }
    },

    destroy() {
      this.unsubscribe?.();
    },

    get id() { return this.$store.route.params.id; },

    async reload() {
      try {
        const [list, items] = await Promise.all([getFavoriteList(this.id), listFavoriteItems(this.id)]);
        this.list = list;
        this.items = sortItems(items);
        this.selected = this.selected.filter((id) => items.some((it) => it.id === id));
        this.error = '';
      } catch (err) {
        this.list = null;
        this.error = err?.status === 404 ? 'Diese Favoritenliste gibt es nicht (mehr).' : errorMessage(err);
      }
    },

    isOwner() { return !!this.list && this.list.owner === this.$store.auth.user?.id; },
    ownerName() { return this.list?.expand?.owner?.name || this.list?.expand?.owner?.email || 'unbekannt'; },

    priceText(it) {
      const stand = it.price_date ? ' (' + monthYear.format(new Date(it.price_date.replace(' ', 'T'))) + ')' : '';
      return 'zuletzt ' + fmt.eur(it.price_unit) + stand;
    },

    // ---- Auswahl --------------------------------------------------------------
    toggle(id, on) {
      this.selected = on ? [...new Set([...this.selected, id])] : this.selected.filter((x) => x !== id);
    },
    allSelected() { return this.items.length > 0 && this.selected.length === this.items.length; },
    selectAll(on) { this.selected = on ? this.items.map((it) => it.id) : []; },

    // ---- In den Warenkorb -------------------------------------------------------
    async startCart() {
      if (!this.courses.length) {
        try {
          this.courses = groupsByCourse(await listGroups({ onlyActive: true }));
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }
      this.cart = {
        open: true,
        groupAll: '',
        rows: this.items.filter((it) => this.selected.includes(it.id)).map((it) => ({ ...it, group: '' })),
      };
    },

    applyGroupAll() {
      for (const row of this.cart.rows) row.group = this.cart.groupAll;
    },

    async submitCart() {
      const bad = this.cart.rows.find((r) => !Number.isInteger(r.qty) || r.qty < 1);
      if (bad) {
        toast.error(`Menge für ${bad.name || bad.part_number}: bitte eine ganze Zahl ≥ 1.`);
        return;
      }
      this.busy = true;
      try {
        const res = await addItemsToCarts(this.cart.rows.map((r, i) => ({
          line: i + 1,
          supplier: this.list.supplier,
          supplier_custom_name: this.list.supplier_custom_name,
          part_number: r.part_number,
          name: r.name,
          url: r.url,
          qty: r.qty,
          price_unit: r.price_unit || null,
          group: r.group,
        })));
        toast.success(`${res.items} Artikel in den Warenkorb gelegt` + (res.merged ? `, ${res.merged} mit vorhandenen Positionen zusammengeführt.` : '.'));
        this.cart.open = false;
        this.selected = [];
        const order = await findOpenCart(this.list.supplier, this.list.supplier_custom_name).catch(() => null);
        if (order) location.hash = '#/orders/' + order.id;
      } catch (err) {
        // Fehler des Sammel-Imports nennen die Zeile – hier die Bezeichnung des Artikels
        const msg = errorMessage(err).replace(/Zeile (\d+):/, (m, n) => {
          const row = this.cart.rows[Number(n) - 1];
          return row ? `${row.name || row.part_number}:` : m;
        });
        toast.error(msg);
      } finally {
        this.busy = false;
      }
    },

    // ---- Artikel bearbeiten (Besitzer) ---------------------------------------
    startItem(it = null) {
      this.itemForm = {
        open: true,
        id: it?.id ?? null,
        data: it
          ? { part_number: it.part_number, name: it.name, qty: it.qty, price_unit: it.price_unit ? String(it.price_unit).replace('.', ',') : '', url: it.url }
          : emptyItem(),
      };
      this.$nextTick(() => this.$refs.part?.focus());
    },

    async saveItem() {
      const d = this.itemForm.data;
      const price = numberOrNull(d.price_unit);
      if (d.price_unit !== '' && (price === null || price < 0)) {
        toast.error('Der Stückpreis ist keine gültige Zahl.');
        return;
      }
      this.busy = true;
      try {
        const data = { part_number: d.part_number, name: d.name.trim(), qty: d.qty, price_unit: price ?? 0, url: d.url.trim() };
        if (this.itemForm.id) await updateFavoriteItem(this.itemForm.id, data);
        else await createFavoriteItem({ ...data, list: this.list.id });
        this.itemForm.open = false;
        await this.reload();
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    async removeItem() {
      const d = this.itemForm.data;
      if (!(await confirmAction(`„${d.name || d.part_number}“ aus der Liste entfernen?`, { confirmLabel: 'Entfernen', danger: true }))) return;
      try {
        await deleteFavoriteItem(this.itemForm.id);
        this.itemForm.open = false;
        await this.reload();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    // ---- Liste bearbeiten (Besitzer) -----------------------------------------
    startEditList() {
      const l = this.list;
      this.listForm = {
        open: true,
        data: { title: l.title, description: l.description, is_public: !!l.is_public, supplier_custom_name: l.supplier_custom_name },
      };
    },

    async saveList() {
      this.busy = true;
      try {
        const d = this.listForm.data;
        const data = { title: d.title.trim(), description: d.description.trim(), is_public: d.is_public };
        if (this.list.supplier === 'other') data.supplier_custom_name = d.supplier_custom_name.trim();
        await updateFavoriteList(this.list.id, data);
        this.listForm.open = false;
        await this.reload();
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    async removeList() {
      if (!(await confirmAction(`Favoritenliste „${this.list.title}“ mit ${this.items.length} Artikel(n) löschen?`,
        { confirmLabel: 'Löschen', danger: true }))) return;
      try {
        await deleteFavoriteList(this.list.id);
        this.listForm.open = false;
        toast.success('Favoritenliste gelöscht.');
        location.hash = '#/favorites';
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
  };
}

export default { dataName: 'favoriteListView', template, component };
