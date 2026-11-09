// Übersicht aller Bestellungen mit Filtern, Erfassung neuer Positionen und Plugin-Slot.
import { SUPPLIERS, STATUSES, supplierLabel, orderNumbersLabel, statusMeta, groupsByCourse, groupLabel } from '../core/config.js';
import { listOrders, listGroups, orderTotals, subscribe, errorMessage } from '../core/api.js';
import { getPlugins } from '../core/plugin-registry.js';
import { fmt, toast } from '../core/ui.js';
import { itemFormFields } from './item-form.js';

const FILTER_KEY = 'dashboard-filters';

const template = /* html */ `
<div x-data="dashboardView">
  <div class="mb-4 flex flex-wrap items-center gap-2">
    <h1 class="mr-auto text-xl font-semibold">Bestellungen</h1>
    <template x-for="p in plugins()" :key="p.id">
      <button type="button" class="btn btn-secondary" @click="runPlugin(p)" x-text="p.label"></button>
    </template>
    <button type="button" class="btn btn-primary" @click="showForm = true">+ Position erfassen</button>
  </div>

  <!-- Filter: auf dem Smartphone eingeklappt, aktive Filter als Chips -->
  <div class="mb-3 flex flex-wrap items-center gap-2 sm:hidden">
    <button type="button" class="btn btn-secondary btn-sm" @click="filtersOpen = !filtersOpen" :aria-expanded="filtersOpen">
      Filter
      <span x-show="activeFilters().length" class="rounded-full bg-blue-600 px-1.5 text-[10px] text-white" x-text="activeFilters().length"></span>
      <span x-text="filtersOpen ? '▴' : '▾'"></span>
    </button>
    <template x-for="f in activeFilters()" :key="f.key">
      <button type="button" class="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs text-blue-800 ring-1 ring-blue-200"
              @click="clearFilter(f.key)" :aria-label="'Filter ' + f.label + ' entfernen'">
        <span x-text="f.label"></span><span aria-hidden="true">✕</span>
      </button>
    </template>
  </div>
  <div class="card mb-4 grid-cols-1 gap-3 p-3 sm:grid sm:grid-cols-3" :class="filtersOpen ? 'grid' : 'hidden'">
    <div>
      <label class="label">Status</label>
      <select class="input" x-model="filters.status" @change="filtersChanged()">
        <option value="">Alle</option>
        <template x-for="s in statuses" :key="s.value"><option :value="s.value" x-text="s.label"></option></template>
      </select>
    </div>
    <div>
      <label class="label">Lieferant</label>
      <select class="input" x-model="filters.supplier" @change="filtersChanged()">
        <option value="">Alle</option>
        <template x-for="s in suppliers" :key="s.value"><option :value="s.value" x-text="s.label"></option></template>
      </select>
    </div>
    <div>
      <label class="label">Gruppe</label>
      <select class="input" x-model="filters.group" @change="filtersChanged()">
        <option value="">Alle</option>
        <template x-for="c in groupsByCourse(groups)" :key="c.label">
          <optgroup :label="c.label">
            <template x-for="g in c.groups" :key="g.id"><option :value="g.id" x-text="g.name"></option></template>
          </optgroup>
        </template>
      </select>
    </div>
  </div>

  <p x-show="error" x-text="error" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>
  <p x-show="loading && !orders.length" class="py-8 text-center text-sm text-slate-500">Lade …</p>
  <p x-show="!loading && !orders.length && !error" class="card p-8 text-center text-sm text-slate-500">
    Keine Bestellungen gefunden.
  </p>

  <!-- Liste -->
  <ul class="grid gap-3 md:grid-cols-2">
    <template x-for="o in orders" :key="o.id">
      <li>
        <a :href="'#/orders/' + o.id" class="card block p-4 transition hover:border-blue-300 hover:shadow">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="truncate font-semibold" x-text="supplierLabel(o)"></div>
              <div class="text-xs text-slate-500">
                <span x-text="orderNumbersLabel(o)"></span>
                · <span x-text="fmt.date(o.created)"></span>
              </div>
            </div>
            <span class="badge" :class="statusMeta(o.status).badge" x-text="statusMeta(o.status).label"></span>
          </div>
          <div class="mt-3 flex items-center justify-between text-sm text-slate-600">
            <span x-text="summary(o).positions + (summary(o).positions === 1 ? ' Position' : ' Positionen')"></span>
            <span x-text="fmt.eur(summary(o).net) + ' netto'"></span>
          </div>
          <template x-if="o.status !== 'angefragt'">
            <div class="mt-2">
              <div class="h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div class="h-full rounded-full bg-emerald-500" :style="'width:' + summary(o).progress + '%'"></div>
              </div>
              <div class="mt-1 text-xs text-slate-500">
                <span x-text="summary(o).done + ' von ' + summary(o).positions + ' Positionen erledigt'"></span>
                <span x-show="summary(o).backlog > 0" x-text="' · Rückstand ' + summary(o).backlog + ' Stk.'"></span>
              </div>
            </div>
          </template>
        </a>
      </li>
    </template>
  </ul>

  <!-- Modal: Position erfassen -->
  <div x-show="showForm" x-transition.opacity class="modal-backdrop" @keydown.escape.window="showForm = false"
       @click.self="showForm = false">
    <div class="modal-panel" @item-form-cancel="showForm = false" @item-added="reload()">
      <h2 class="mb-4 text-lg font-semibold">Position erfassen</h2>
      <template x-if="showForm">
        <div x-data="itemForm({})">${itemFormFields}</div>
      </template>
    </div>
  </div>
</div>`;

function loadFilters() {
  try {
    return { status: '', supplier: '', group: '', ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') };
  } catch {
    return { status: '', supplier: '', group: '' };
  }
}

function component() {
  return {
    statuses: STATUSES,
    suppliers: SUPPLIERS,
    supplierLabel,
    orderNumbersLabel,
    statusMeta,
    groupsByCourse,
    fmt,
    filters: loadFilters(),
    groups: [],
    orders: [],
    loading: false,
    error: '',
    showForm: false,
    filtersOpen: false,
    unsubscribe: null,

    async init() {
      listGroups().then((g) => { this.groups = g; }).catch(() => {});
      await this.reload();
      try {
        this.unsubscribe = await subscribe(['orders', 'order_items'], () => this.reload());
      } catch (err) {
        console.warn('Realtime nicht verfügbar', err);
      }
    },

    destroy() {
      this.unsubscribe?.();
    },

    plugins() {
      void this.$store.plugins.version; // reaktiv bei nachgeladenen Modulen
      return getPlugins('dashboard-actions');
    },

    runPlugin(p) {
      try {
        p.onClick();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    activeFilters() {
      const list = [];
      if (this.filters.status) list.push({ key: 'status', label: STATUSES.find((s) => s.value === this.filters.status)?.label ?? this.filters.status });
      if (this.filters.supplier) list.push({ key: 'supplier', label: SUPPLIERS.find((s) => s.value === this.filters.supplier)?.label ?? this.filters.supplier });
      if (this.filters.group) list.push({ key: 'group', label: groupLabel(this.groups.find((g) => g.id === this.filters.group)) || 'Gruppe' });
      return list;
    },

    clearFilter(key) {
      this.filters[key] = '';
      this.filtersChanged();
    },

    filtersChanged() {
      try { localStorage.setItem(FILTER_KEY, JSON.stringify(this.filters)); } catch { /* egal */ }
      this.reload();
    },

    async reload() {
      this.loading = true;
      try {
        this.orders = await listOrders(this.filters);
        this.error = '';
      } catch (err) {
        this.error = errorMessage(err);
      } finally {
        this.loading = false;
      }
    },

    summary(order) {
      const items = order.expand?.order_items_via_order ?? [];
      const done = items.filter((it) => it.qty_delivered + it.qty_cancelled >= it.qty_ordered).length;
      const backlog = items.reduce((s, it) => s + Math.max(0, it.qty_ordered - it.qty_delivered - it.qty_cancelled), 0);
      return {
        positions: items.length,
        done,
        backlog,
        progress: items.length ? Math.round((done / items.length) * 100) : 0,
        net: orderTotals(order, items).net,
      };
    },
  };
}

export default { dataName: 'dashboardView', template, component };
