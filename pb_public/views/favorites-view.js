// Favoriten: Übersicht aller Listen (ARCHITECTURE.md Kap. 4.7).
// Alle Listen sind für alle sichtbar; der voreingestellte Filter zeigt nur eigene und öffentliche (pro Browser gemerkt).
import { SUPPLIERS, supplierLabel } from '../core/config.js';
import { listFavoriteLists, createFavoriteList, subscribe, errorMessage } from '../core/api.js';
import { toast } from '../core/ui.js';

const FILTER_KEY = 'favorites-filter';

function loadOnlyMineAndPublic() {
  try {
    const v = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null');
    return v?.onlyMineAndPublic ?? true;
  } catch (_) {
    return true;
  }
}

function emptyForm() {
  return { title: '', description: '', is_public: false, supplier: 'reichelt', supplier_custom_name: '' };
}

const template = /* html */ `
<div x-data="favoritesView">
  <div class="mb-3 flex flex-wrap items-center gap-2">
    <h1 class="mr-auto text-xl font-semibold">Favoriten</h1>
    <button type="button" class="btn btn-primary" @click="startCreate()">+ Liste</button>
  </div>
  <p class="mb-3 text-sm text-slate-600">
    Merklisten für Artikel, die wieder bestellt werden. Jede Liste gehört zu einem Lieferanten;
    Artikel lassen sich aus Bestellungen übernehmen („In Favoriten“) und von hier in den Warenkorb legen.
  </p>

  <label class="mb-3 flex items-center gap-2 text-sm text-slate-600" data-favorites-filter>
    <input type="checkbox" x-model="onlyMineAndPublic" @change="saveFilter()">
    Nur eigene und öffentliche Listen
  </label>

  <p x-show="error" x-text="error" class="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>
  <p x-show="loading && !lists.length" class="text-sm text-slate-500">Lade …</p>

  <template x-for="s in sections()" :key="s.key">
    <section class="mb-4">
      <h2 class="mb-1.5 text-sm font-semibold text-slate-700" x-text="s.label"></h2>
      <ul class="grid gap-2 sm:grid-cols-2">
        <template x-for="l in s.lists" :key="l.id">
          <li>
            <a :href="'#/favorites/' + l.id" class="card block h-full p-3 transition hover:border-blue-300" :data-favorite-list="l.title">
              <div class="flex items-start gap-2">
                <span class="min-w-0 flex-1 font-medium" x-text="l.title"></span>
                <span x-show="l.is_public" class="badge bg-emerald-50 text-emerald-700 border-emerald-300">öffentlich</span>
                <span x-show="!l.is_public" class="badge bg-slate-100 text-slate-600 border-slate-300">nicht öffentlich</span>
              </div>
              <p x-show="l.description" class="mt-1 line-clamp-2 text-sm text-slate-600" x-text="l.description"></p>
              <p class="mt-1 text-xs text-slate-500" x-text="itemCount(l) + ' Artikel · ' + (isMine(l) ? 'eigene Liste' : 'von ' + ownerName(l))"></p>
            </a>
          </li>
        </template>
      </ul>
    </section>
  </template>
  <p x-show="!loading && !error && !visibleLists().length" class="card p-6 text-center text-sm text-slate-500"
     x-text="lists.length ? 'Keine eigenen oder öffentlichen Listen. Filter ausschalten, um alle Listen zu sehen.' : 'Noch keine Favoritenlisten.'"></p>

  <!-- Modal: neue Liste -->
  <div x-show="form.open" x-transition.opacity class="modal-backdrop" @click.self="form.open = false"
       @keydown.escape.window="form.open = false">
    <form class="modal-panel space-y-3" @submit.prevent="create()" data-favorite-list-form>
      <h2 class="text-lg font-semibold">Neue Favoritenliste</h2>
      <div>
        <label class="label" for="fav-title">Titel</label>
        <input id="fav-title" class="input" x-model="form.data.title" x-ref="title" required maxlength="150"
               placeholder="z. B. Bürobedarf Standard">
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div :class="form.data.supplier === 'other' ? '' : 'col-span-2'">
          <label class="label" for="fav-supplier">Lieferant</label>
          <select id="fav-supplier" class="input" x-model="form.data.supplier">
            <template x-for="s in suppliers" :key="s.value"><option :value="s.value" x-text="s.label"></option></template>
          </select>
        </div>
        <div x-show="form.data.supplier === 'other'">
          <label class="label" for="fav-shop">Shop-Name</label>
          <input id="fav-shop" class="input" x-model="form.data.supplier_custom_name" maxlength="100"
                 :required="form.data.supplier === 'other'" placeholder="z. B. Conrad">
        </div>
      </div>
      <p class="hint -mt-1">Der Lieferant lässt sich später nicht mehr ändern.</p>
      <div>
        <label class="label" for="fav-description">Beschreibung <span class="font-normal text-slate-500">(optional)</span></label>
        <textarea id="fav-description" class="input" rows="2" x-model="form.data.description" maxlength="1000"></textarea>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <input type="checkbox" x-model="form.data.is_public"> öffentlich (erscheint bei allen im voreingestellten Filter)
      </label>
      <div class="flex justify-end gap-2 pt-1">
        <button type="button" class="btn btn-secondary" @click="form.open = false">Abbrechen</button>
        <button type="submit" class="btn btn-primary" :disabled="busy">Anlegen</button>
      </div>
    </form>
  </div>
</div>`;

function component() {
  return {
    suppliers: SUPPLIERS,
    lists: [],
    loading: true,
    error: '',
    busy: false,
    onlyMineAndPublic: loadOnlyMineAndPublic(),
    form: { open: false, data: emptyForm() },
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

    async reload() {
      try {
        this.lists = await listFavoriteLists();
        this.error = '';
      } catch (err) {
        this.error = errorMessage(err);
      } finally {
        this.loading = false;
      }
    },

    saveFilter() {
      try { localStorage.setItem(FILTER_KEY, JSON.stringify({ onlyMineAndPublic: this.onlyMineAndPublic })); } catch (_) { /* egal */ }
    },

    isMine(l) { return l.owner === this.$store.auth.user?.id; },
    ownerName(l) { return l.expand?.owner?.name || l.expand?.owner?.email || 'unbekannt'; },
    itemCount(l) { return (l.expand?.favorite_items_via_list || []).length; },

    visibleLists() {
      return this.onlyMineAndPublic ? this.lists.filter((l) => l.is_public || this.isMine(l)) : this.lists;
    },

    /** Listen nach Lieferant gegliedert (Reihenfolge wie in der Lieferantenauswahl, „sonstige“ je Shop-Name). */
    sections() {
      const order = (v) => SUPPLIERS.findIndex((s) => s.value === v);
      const map = new Map();
      for (const l of this.visibleLists()) {
        const key = l.supplier + '\u0000' + (l.supplier === 'other' ? l.supplier_custom_name.toLowerCase() : '');
        if (!map.has(key)) map.set(key, { key, label: supplierLabel(l), supplier: l.supplier, lists: [] });
        map.get(key).lists.push(l);
      }
      return [...map.values()].sort((a, b) => order(a.supplier) - order(b.supplier) || a.label.localeCompare(b.label, 'de'));
    },

    startCreate() {
      this.form = { open: true, data: emptyForm() };
      this.$nextTick(() => this.$refs.title?.focus());
    },

    async create() {
      this.busy = true;
      try {
        const d = this.form.data;
        const list = await createFavoriteList({
          ...d,
          title: d.title.trim(),
          description: d.description.trim(),
          supplier_custom_name: d.supplier === 'other' ? d.supplier_custom_name.trim() : '',
        });
        this.form.open = false;
        location.hash = '#/favorites/' + list.id;
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },
  };
}

export default { dataName: 'favoritesView', template, component };
