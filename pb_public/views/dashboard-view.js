// Startseite „Bestellungen“ (ARCHITECTURE.md Kap. 7): Warenkörbe als Leiste, Bestellungen als Tabelle mit den
// Verwaltungsschritten (PC) bzw. als Karten (Smartphone), Filter, Suche, Erfassung neuer Positionen, Plugin-Slot.
// Schritte werden direkt in der Tabelle abgehakt (views/order-steps.js, „Handeln statt fragen“).
import { SUPPLIERS, STATUSES, supplierLabel, statusMeta, stepMeta, groupsByCourse, groupLabel } from '../core/config.js';
import { listOverviewOrders, listOpenCarts, listGroups, subscribe, errorMessage } from '../core/api.js';
import { getPlugins } from '../core/plugin-registry.js';
import { fmt, toast } from '../core/ui.js';
import { itemFormFields } from './item-form.js';
import { unmatchedReceiptsSection } from './unmatched-receipts.js';
import { STEP_BOX, stepView, nextStepOf, toggleStep } from './order-steps.js';

const FILTER_KEY = 'overview-filters';
const SEARCH_DELAY_MS = 300;
/** Reihenfolge der Phasen in der Liste; abgeschlossene am Ende. */
const PHASE_ORDER = STATUSES.map((s) => s.value);
const TABLE_PHASES = STATUSES.filter((s) => s.value !== 'angefragt');

const template = /* html */ `
<div x-data="dashboardView" @order-steps-changed.window="reload()">
  <!-- Smartphone: Hauptaufgabe (Lieferschein scannen) groß oben -->
  <template x-for="p in plugins().filter((p) => p.prominent)" :key="'m-' + p.id">
    <button type="button" class="btn btn-primary mb-3 w-full py-3 text-base sm:hidden" data-prominent-action
            @click="runPlugin(p)" x-text="p.label"></button>
  </template>

  <div class="mb-4 flex flex-wrap items-center gap-2">
    <h1 class="w-full text-xl font-semibold sm:mr-auto sm:w-auto">Bestellungen</h1>
    <input type="search" class="input order-last w-full sm:order-none sm:w-64" placeholder="Suchen: Nr., Lieferant, Was, Artikel"
           x-model="search" @input="searchChanged()" aria-label="Bestellungen durchsuchen" data-overview-search>
    <template x-for="p in plugins()" :key="p.id">
      <button type="button" class="btn btn-secondary" :class="p.prominent && 'hidden sm:inline-flex'" @click="runPlugin(p)" x-text="p.label"></button>
    </template>
    <button type="button" class="btn btn-primary" @click="showForm = true">+ Position erfassen</button>
  </div>

  ${unmatchedReceiptsSection}

  <!-- Offene Warenkörbe -->
  <section x-show="carts.length" class="mb-4" data-carts>
    <h2 class="mb-2 text-sm font-semibold text-slate-700">Warenkörbe</h2>
    <div class="flex flex-wrap gap-2">
      <template x-for="c in carts" :key="c.id">
        <a :href="'#/orders/' + c.id" class="card px-3 py-2 text-sm transition hover:border-blue-300 hover:shadow" data-cart>
          <span class="font-medium" x-text="supplierLabel(c)"></span>
          <span class="text-slate-500" x-text="' · ' + positionsLabel(c)"></span>
        </a>
      </template>
    </div>
  </section>

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
  <div class="mb-4 flex-wrap items-end gap-x-4 gap-y-3 sm:flex" :class="filtersOpen ? 'flex' : 'hidden'" data-overview-filters>
    <div class="w-full sm:w-auto">
      <span class="label">Phase</span>
      <div class="flex flex-wrap gap-1.5">
        <template x-for="ph in tablePhases" :key="ph.value">
          <button type="button" class="rounded-full px-2.5 py-1 text-xs ring-1 ring-inset transition"
                  :class="filters.phases.includes(ph.value) ? 'bg-blue-600 text-white ring-blue-600' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'"
                  :aria-pressed="filters.phases.includes(ph.value)" @click="togglePhase(ph.value)" x-text="ph.label"></button>
        </template>
      </div>
    </div>
    <div class="w-full sm:w-auto">
      <label class="label" for="filter-period">Abgeschlossene</label>
      <select id="filter-period" class="input" x-model="filters.period" @change="filtersChanged()">
        <template x-for="p in periods()" :key="p.value"><option :value="p.value" x-text="p.label"></option></template>
      </select>
    </div>
    <div class="w-full sm:w-auto">
      <label class="label" for="filter-supplier">Lieferant</label>
      <select id="filter-supplier" class="input" x-model="filters.supplier" @change="filtersChanged()">
        <option value="">Alle</option>
        <template x-for="s in suppliers" :key="s.value"><option :value="s.value" x-text="s.label"></option></template>
      </select>
    </div>
    <div class="w-full sm:w-auto">
      <label class="label" for="filter-group">Gruppe</label>
      <select id="filter-group" class="input" x-model="filters.group" @change="filtersChanged()">
        <option value="">Alle</option>
        <template x-for="c in groupsByCourse(groups)" :key="c.label">
          <optgroup :label="c.label">
            <template x-for="g in c.groups" :key="g.id"><option :value="g.id" x-text="g.name"></option></template>
          </optgroup>
        </template>
      </select>
    </div>
  </div>

  <p x-show="search.trim()" class="mb-2 text-sm text-slate-600">
    Suche in allen Bestellungen (Phase und Zeitraum werden nicht berücksichtigt).
  </p>
  <p x-show="error" x-text="error" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>
  <p x-show="loading && !rows.length" class="py-8 text-center text-sm text-slate-500">Lade …</p>
  <p x-show="!loading && !rows.length && !error" class="card p-8 text-center text-sm text-slate-500">
    Keine Bestellungen gefunden.
  </p>

  <!-- PC: Tabelle wie die bisherige Verwaltungstabelle -->
  <div x-show="rows.length" class="card hidden overflow-x-auto lg:block" data-overview-table>
    <table class="w-full text-sm">
      <thead class="text-xs text-slate-500">
        <tr>
          <th rowspan="2" class="px-3 pt-2 text-left font-semibold">Bestell-Nr.</th>
          <th rowspan="2" class="px-3 pt-2 text-left font-semibold">Wo</th>
          <th rowspan="2" class="px-3 pt-2 text-left font-semibold">Was</th>
          <template x-for="g in columnGroups" :key="g.label">
            <th :colspan="g.steps.length" class="border-l border-slate-200 px-2 pt-2 text-center font-semibold" x-text="g.label"></th>
          </template>
        </tr>
        <tr>
          <template x-for="g in columnGroups" :key="'h-' + g.label">
            <template x-for="(s, i) in g.steps" :key="s.value">
              <th class="px-1 pb-2 pt-1 text-center font-normal" :class="i === 0 && 'border-l border-slate-200'" :title="s.label" x-text="s.short"></th>
            </template>
          </template>
        </tr>
      </thead>
      <tbody>
        <template x-for="row in rows" :key="row.order.id">
          <tr class="border-t border-slate-100 hover:bg-slate-50/60" :class="row.closed && 'text-slate-400'" :data-order="row.order.id">
            <td class="whitespace-nowrap px-3 py-2 font-mono text-xs">
              <a :href="'#/orders/' + row.order.id" class="hover:text-blue-700 hover:underline" x-text="row.number"></a>
            </td>
            <td class="whitespace-nowrap px-3 py-2">
              <a :href="'#/orders/' + row.order.id" class="font-medium hover:text-blue-700 hover:underline" x-text="supplierLabel(row.order)"></a>
            </td>
            <td class="px-3 py-2">
              <a :href="'#/orders/' + row.order.id" class="hover:text-blue-700 hover:underline" x-text="row.order.subject || '–'"></a>
            </td>
            <template x-for="track in row.view" :key="track.key">
              <template x-for="(s, i) in track.steps" :key="s.value">
                <td class="px-1 py-2 text-center" :class="{ 'border-l border-slate-100': i === 0, 'opacity-50': row.closed }">
                  <button type="button" class="inline-flex rounded align-middle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                          :class="s.clickable ? 'cursor-pointer' : 'cursor-default'" :disabled="!s.clickable"
                          :title="s.tooltip" :aria-label="s.tooltip" :data-step="s.value" :data-state="s.state"
                          @click="toggleStep(row.order, row.steps, s.value)">${STEP_BOX}</button>
                </td>
              </template>
            </template>
          </tr>
        </template>
      </tbody>
    </table>
  </div>

  <!-- Smartphone/Tablet: Karten -->
  <ul class="grid gap-2 md:grid-cols-2 lg:hidden">
    <template x-for="row in rows" :key="row.order.id">
      <li>
        <a :href="'#/orders/' + row.order.id" class="card block p-3 transition hover:border-blue-300" :class="row.closed && 'opacity-60'">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="truncate font-semibold">
                <span x-text="supplierLabel(row.order)"></span><span x-show="row.order.subject" class="font-normal text-slate-600" x-text="' · ' + row.order.subject"></span>
              </div>
              <div class="text-xs text-slate-500" x-text="row.number + ' · ' + fmt.date(row.order.created)"></div>
            </div>
            <span class="badge" :class="statusMeta(row.order.status).badge" x-text="statusMeta(row.order.status).label"></span>
          </div>
          <div x-show="row.next" class="mt-2 text-sm text-slate-600">
            Nächster Schritt: <span class="font-medium text-slate-900" x-text="row.next && stepMeta(row.next).label"></span>
          </div>
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

function defaultFilters() {
  return { phases: [], period: '3m', supplier: '', group: '' };
}

function loadFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}');
    return { ...defaultFilters(), ...saved, phases: Array.isArray(saved.phases) ? saved.phases : [] };
  } catch {
    return defaultFilters();
  }
}

/** Steps einer Bestellung aus dem Expand als { step: record }. */
function stepsOf(order) {
  return Object.fromEntries((order.expand?.order_steps_via_order ?? []).map((s) => [s.step, s]));
}

/** Sortierung: Phase, darin älteste zuerst; abgeschlossene: zuletzt abgeschlossene zuerst. */
function compareRows(a, b) {
  const pa = PHASE_ORDER.indexOf(a.order.status);
  const pb = PHASE_ORDER.indexOf(b.order.status);
  if (pa !== pb) return pa - pb;
  if (a.closed) return (b.order.closed_at || '').localeCompare(a.order.closed_at || '');
  return a.order.created.localeCompare(b.order.created);
}

function component() {
  return {
    suppliers: SUPPLIERS,
    tablePhases: TABLE_PHASES,
    supplierLabel, statusMeta, stepMeta, groupsByCourse, fmt, toggleStep,
    filters: loadFilters(),
    search: '',
    searchTimer: null,
    groups: [],
    carts: [],
    rows: [],
    /** Spaltengruppen der Tabelle (Bestellung, Ware, Rechnung) – aus der Schrittdefinition. */
    columnGroups: stepView({ status: 'angefragt' }, {}).map((t) => ({ label: t.label, steps: t.steps })),
    loading: false,
    error: '',
    showForm: false,
    filtersOpen: false,
    unsubscribe: null,
    reloadSeq: 0,

    async init() {
      listGroups().then((g) => { this.groups = g; }).catch(() => {});
      await this.reload();
      try {
        this.unsubscribe = await subscribe(['orders', 'order_items', 'order_steps', 'deliveries'], () => this.reload());
      } catch (err) {
        console.warn('Realtime nicht verfügbar', err);
      }
    },

    destroy() {
      this.unsubscribe?.();
      clearTimeout(this.searchTimer);
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

    positionsLabel(order) {
      const n = order.expand?.order_items_via_order?.length ?? 0;
      return n === 1 ? '1 Position' : `${n} Positionen`;
    },

    periods() {
      const year = new Date().getFullYear();
      return [
        { value: '3m', label: 'letzte 3 Monate' },
        { value: '12m', label: 'letzte 12 Monate' },
        ...[year, year - 1, year - 2].map((y) => ({ value: `year:${y}`, label: String(y) })),
        { value: 'all', label: 'alle' },
      ];
    },

    togglePhase(value) {
      const set = new Set(this.filters.phases);
      if (set.has(value)) set.delete(value); else set.add(value);
      this.filters.phases = PHASE_ORDER.filter((p) => set.has(p));
      this.filtersChanged();
    },

    /** Vom Standard abweichende Filter (Chips auf dem Smartphone). */
    activeFilters() {
      const list = [];
      if (this.filters.phases.length) list.push({ key: 'phases', label: this.filters.phases.map((p) => statusMeta(p).label).join(', ') });
      if (this.filters.period !== '3m') list.push({ key: 'period', label: 'Abgeschlossene: ' + (this.periods().find((p) => p.value === this.filters.period)?.label ?? '') });
      if (this.filters.supplier) list.push({ key: 'supplier', label: SUPPLIERS.find((s) => s.value === this.filters.supplier)?.label ?? this.filters.supplier });
      if (this.filters.group) list.push({ key: 'group', label: groupLabel(this.groups.find((g) => g.id === this.filters.group)) || 'Gruppe' });
      return list;
    },

    clearFilter(key) {
      this.filters[key] = defaultFilters()[key];
      this.filtersChanged();
    },

    filtersChanged() {
      try { localStorage.setItem(FILTER_KEY, JSON.stringify(this.filters)); } catch { /* egal */ }
      this.reload();
    },

    searchChanged() {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.reload(), SEARCH_DELAY_MS);
    },

    async reload() {
      const seq = ++this.reloadSeq; // späte Antworten älterer Anfragen verwerfen (schnelles Tippen, Realtime)
      this.loading = true;
      try {
        const [orders, carts] = await Promise.all([
          listOverviewOrders({ ...this.filters, search: this.search }),
          listOpenCarts(),
        ]);
        if (seq !== this.reloadSeq) return;
        this.carts = carts;
        this.rows = orders.map((order) => {
          const steps = stepsOf(order);
          return {
            order,
            steps,
            view: stepView(order, steps, order.expand?.deliveries_via_order ?? []),
            next: nextStepOf(order, steps),
            closed: order.status === 'abgeschlossen',
            number: order.internal_order_no || (order.without_internal_order_no ? 'ohne Nr.' : '–'),
          };
        }).sort(compareRows);
        this.error = '';
      } catch (err) {
        if (seq === this.reloadSeq) this.error = errorMessage(err);
      } finally {
        if (seq === this.reloadSeq) this.loading = false;
      }
    },
  };
}

export default { dataName: 'dashboardView', template, component };
