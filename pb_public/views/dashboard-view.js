// Startseite „Bestellungen“ (ARCHITECTURE.md Kap. 7): Bestellungen als Tabelle mit den
// Verwaltungsschritten (PC) bzw. kompakt mit aufklappbaren Schritten (Smartphone/Tablet), Filter, Suche und
// Plugin-Slot 'dashboard-actions'. Warenkörbe und „Position erfassen“: Warenkorb-Symbol (views/cart-menu.js).
// Schritte werden direkt in der Tabelle abgehakt (views/order-steps.js, „Handeln statt fragen“).
import { SUPPLIERS, STATUSES, supplierLabel, statusMeta, groupsByCourse, groupLabel } from '../core/config.js';
import { listOverviewOrders, listGroups, subscribe, errorMessage } from '../core/api.js';
import { getPlugins } from '../core/plugin-registry.js';
import { fmt, toast } from '../core/ui.js';
import { unmatchedReceiptsSection } from './unmatched-receipts.js';
import { STEP_BOX, stepView, toggleStep } from './order-steps.js';

const FILTER_KEY = 'overview-filters';
const SEARCH_DELAY_MS = 300;
/** Reihenfolge der Phasen in der Liste; abgeschlossene am Ende. */
const PHASE_ORDER = STATUSES.map((s) => s.value);
const TABLE_PHASES = STATUSES.filter((s) => s.value !== 'angefragt');

const template = /* html */ `
<div x-data="dashboardView" @order-steps-changed.window="reload()">
  <div class="mb-4 flex flex-wrap items-center gap-2">
    <h1 class="mr-auto text-xl font-semibold">Bestellungen</h1>
    <template x-for="p in plugins()" :key="p.id">
      <button type="button" class="btn btn-secondary" @click="runPlugin(p)" x-text="p.label"></button>
    </template>
  </div>

  ${unmatchedReceiptsSection}

  <!-- Suche: auf dem PC rechts in der Filterzeile (füllt den Rest), auf Smartphone/Tablet über dem Filter-Knopf -->
  <div class="mb-4 flex flex-wrap items-start gap-x-4 gap-y-3">
  <div class="w-full lg:order-last lg:w-auto lg:min-w-48 lg:flex-1">
    <label class="label hidden lg:block" for="overview-search">Suche</label>
    <input type="search" id="overview-search" class="input" placeholder="Nr., Lieferant, Was, Artikel"
           x-model="search" @input="searchChanged()" aria-label="Bestellungen durchsuchen" data-overview-search>
  </div>

  <!-- Filter: auf Smartphone/Tablet eingeklappt, aktive Filter als Chips -->
  <div class="flex w-full flex-wrap items-center gap-2 lg:hidden">
    <button type="button" class="btn btn-secondary btn-sm" @click="filtersOpen = !filtersOpen" :aria-expanded="filtersOpen">
      Filter
      <span x-show="activeFilters().length" class="rounded-full bg-blue-600 px-1.5 text-[10px] text-white" x-text="activeFilters().length"></span>
      <span x-text="filtersOpen ? '▴' : '▾'"></span>
    </button>
    <template x-for="f in activeFilters()" :key="f.key">
      <button type="button" class="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-[9px] py-[3px] text-xs text-blue-800"
              @click="clearFilter(f.key)" :aria-label="'Filter ' + f.label + ' entfernen'">
        <span x-text="f.label"></span><span aria-hidden="true">✕</span>
      </button>
    </template>
  </div>
  <div class="w-full flex-wrap items-start gap-x-4 gap-y-3 lg:flex lg:w-auto" :class="filtersOpen ? 'flex' : 'hidden'" data-overview-filters>
    <div class="w-full sm:w-auto">
      <span class="label">Phase</span>
      <!-- Höhe wie die Auswahlfelder daneben, Chips mittig dazu -->
      <div class="flex min-h-[2.375rem] flex-wrap items-center gap-1.5">
        <template x-for="ph in tablePhases" :key="ph.value">
          <button type="button" class="rounded-full border px-[9px] py-[3px] text-xs transition"
                  :class="filters.phases.includes(ph.value) ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'"
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
  </div>

  <p x-show="search.trim()" class="mb-2 text-sm text-slate-600">
    Suche in allen Bestellungen (Phase und Zeitraum werden nicht berücksichtigt).
  </p>
  <p x-show="error" x-text="error" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>
  <p x-show="loading && !rows.length" class="py-8 text-center text-sm text-slate-500">Lade …</p>
  <p x-show="!loading && !rows.length && !error" class="card p-8 text-center text-sm text-slate-500">
    Keine Bestellungen gefunden.
  </p>

  <!-- Bestellungen als Tabelle. PC (lg+): alle Schritt-Spalten, Klick auf Nr./Wo/Was öffnet die Bestellung.
       Smartphone/Tablet: nur Datum, Nr., Wo, Was (ab sm) und Phase; Antippen klappt die Schritte auf. -->
  <div x-show="rows.length" class="card overflow-x-auto" data-overview-table>
    <table class="w-full text-sm">
      <thead class="text-xs text-slate-500">
        <tr>
          <th rowspan="2" class="px-3 py-2 text-left align-bottom font-semibold">Datum</th>
          <th rowspan="2" class="px-3 py-2 text-left align-bottom font-semibold"><span class="sm:hidden">Best.-Nr.</span><span class="hidden sm:inline">Bestell-Nr.</span></th>
          <th rowspan="2" class="px-3 py-2 text-left align-bottom font-semibold">Wo</th>
          <th rowspan="2" class="hidden px-3 py-2 text-left align-bottom font-semibold sm:table-cell">Was</th>
          <th rowspan="2" class="px-3 py-2 text-left align-bottom font-semibold lg:hidden">Phase</th>
          <th rowspan="2" class="w-8 lg:hidden"><span class="sr-only">Aufklappen</span></th>
          <template x-for="g in columnGroups" :key="g.label">
            <th :colspan="g.steps.length" class="hidden border-l border-slate-200 px-2 pt-2 text-center font-semibold lg:table-cell" x-text="g.label"></th>
          </template>
        </tr>
        <tr class="hidden lg:table-row">
          <template x-for="g in columnGroups" :key="'h-' + g.label">
            <template x-for="(s, i) in g.steps" :key="s.value">
              <th class="px-1 pb-2 pt-1 text-center font-normal" :class="i === 0 && 'border-l border-slate-200'" :title="s.label" x-text="s.short"></th>
            </template>
          </template>
        </tr>
      </thead>
      <template x-for="row in rows" :key="row.order.id">
        <tbody class="border-t border-slate-100" :class="row.closed && 'text-slate-400'">
          <tr class="cursor-pointer hover:bg-slate-50/60 lg:cursor-auto" :data-order="row.order.id" @click="rowClicked(row, $event)">
            <td class="whitespace-nowrap px-3 py-2.5 text-xs lg:py-2" :class="row.closed ? 'text-slate-400' : 'text-slate-600'" :title="'angelegt ' + fmt.date(row.order.created)">
              <span class="sm:hidden" x-text="fmt.shortDate(row.order.created)"></span>
              <span class="hidden sm:inline" x-text="fmt.date(row.order.created)"></span>
            </td>
            <td class="whitespace-nowrap px-3 py-2.5 font-mono text-xs lg:py-2">
              <a :href="'#/orders/' + row.order.id" class="pointer-events-none hover:text-blue-700 hover:underline lg:pointer-events-auto" :title="row.number">
                <span class="sm:hidden" x-text="row.shortNumber"></span><span class="hidden sm:inline" x-text="row.number"></span>
              </a>
            </td>
            <td class="max-w-28 truncate px-3 py-2.5 sm:max-w-none sm:whitespace-nowrap lg:py-2">
              <a :href="'#/orders/' + row.order.id" class="pointer-events-none font-medium hover:text-blue-700 hover:underline lg:pointer-events-auto" x-text="supplierLabel(row.order)"></a>
            </td>
            <td class="hidden px-3 py-2.5 sm:table-cell lg:py-2">
              <a :href="'#/orders/' + row.order.id" class="pointer-events-none line-clamp-1 hover:text-blue-700 hover:underline lg:pointer-events-auto" x-text="row.order.subject || '–'"></a>
            </td>
            <td class="whitespace-nowrap px-3 py-2.5 lg:hidden">
              <span class="badge" :class="statusMeta(row.order.status).badge" x-text="statusMeta(row.order.status).short || statusMeta(row.order.status).label"></span>
            </td>
            <td class="pr-2 text-right lg:hidden">
              <button type="button" class="rounded p-1 text-slate-500" :aria-expanded="!!open[row.order.id]" aria-label="Schritte anzeigen" data-row-toggle>
                <svg viewBox="0 0 20 20" fill="currentColor" class="size-5 transition-transform" :class="open[row.order.id] && 'rotate-180'" aria-hidden="true"><path fill-rule="evenodd" d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg>
              </button>
            </td>
            <template x-for="track in row.view" :key="track.key">
              <template x-for="(s, i) in track.steps" :key="s.value">
                <td class="hidden px-1 py-2 text-center lg:table-cell" :class="{ 'border-l border-slate-100': i === 0, 'opacity-50': row.closed }">
                  <button type="button" class="group/step inline-flex rounded align-middle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                          :class="s.clickable ? 'cursor-pointer' : 'cursor-default'" :aria-disabled="!s.clickable"
                          x-tip="s.tip" :aria-label="s.ariaLabel" :data-step="s.value" :data-state="s.state"
                          @click="s.clickable && toggleStep(row.order, row.steps, s.value)">${STEP_BOX}</button>
                </td>
              </template>
            </template>
          </tr>
          <!-- Aufgeklappt (nur Smartphone/Tablet): Schritte mit Beschriftung, Was, Link zur Bestellung -->
          <tr x-show="open[row.order.id]" class="lg:hidden" data-row-details>
            <td colspan="6" class="bg-slate-50 px-3 pt-1 pb-3" :class="row.closed && 'opacity-60'">
              <p x-show="row.order.subject" class="mb-2 text-sm text-slate-700 sm:hidden" x-text="row.order.subject"></p>
              <template x-for="track in row.view" :key="'m-' + track.key">
                <div class="flex gap-2 py-1">
                  <div class="w-20 shrink-0 pt-1 text-xs font-semibold text-slate-500" x-text="track.label"></div>
                  <div class="flex flex-wrap gap-x-1 gap-y-0.5">
                    <template x-for="s in track.steps" :key="s.value">
                      <button type="button" class="group/step inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-xs text-slate-700 aria-disabled:cursor-default aria-disabled:text-slate-400"
                              :aria-disabled="!s.clickable" x-tip="s.tip" :aria-label="s.ariaLabel" :data-step="s.value" :data-state="s.state"
                              @click="s.clickable && toggleStep(row.order, row.steps, s.value)">${STEP_BOX}<span x-text="s.short"></span></button>
                    </template>
                  </div>
                </div>
              </template>
              <div class="mt-2 flex items-center justify-end gap-3 text-sm">
                <span class="text-slate-500" x-text="positionsLabel(row.order)"></span>
                <a :href="'#/orders/' + row.order.id" class="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-blue-700 hover:bg-blue-50" data-order-details>
                  Positionen &amp; Details <span aria-hidden="true">→</span>
                </a>
              </div>
            </td>
          </tr>
        </tbody>
      </template>
    </table>
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
    supplierLabel, statusMeta, groupsByCourse, fmt, toggleStep,
    filters: loadFilters(),
    search: '',
    searchTimer: null,
    groups: [],
    rows: [],
    /** Spaltengruppen der Tabelle (Bestellung, Ware, Rechnung) – aus der Schrittdefinition. */
    columnGroups: stepView({ status: 'angefragt' }, {}).map((t) => ({ label: t.label, steps: t.steps })),
    loading: false,
    error: '',
    filtersOpen: false,
    /** Aufgeklappte Zeilen (Smartphone/Tablet): { orderId: true } */
    open: {},
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

    /** Smartphone/Tablet: Antippen der Zeile klappt die Schritte auf; am PC öffnen die Links die Bestellung. */
    rowClicked(row, event) {
      if (window.matchMedia('(min-width: 64rem)').matches || event.target.closest('[data-step]')) return;
      this.open = { ...this.open, [row.order.id]: !this.open[row.order.id] };
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
        const orders = await listOverviewOrders({ ...this.filters, search: this.search });
        if (seq !== this.reloadSeq) return;
        this.rows = orders.map((order) => {
          const steps = stepsOf(order);
          return {
            order,
            steps,
            view: stepView(order, steps, order.expand?.deliveries_via_order ?? []),
            closed: order.status === 'abgeschlossen',
            number: order.internal_order_no || (order.without_internal_order_no ? 'ohne Nr.' : '–'),
            // schmale Bildschirme: ohne Jahr und Kürzel („2026IW01051“ → „01051“)
            shortNumber: (order.internal_order_no || '').replace(/^.*IW/i, '') || (order.without_internal_order_no ? 'ohne' : '–'),
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
