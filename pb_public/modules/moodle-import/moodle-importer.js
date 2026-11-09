// Moodle-Import (Beta): CSV-Export der Moodle-Datenbank → Zuordnung (Veranstaltung, Lieferanten, Gruppen)
// → Vorschau → Buchung aller Zeilen in einer Transaktion (POST /api/lab/cart-items/batch).
// Registriert sich im Slot 'dashboard-actions'. Es wird kein Bezug zu Moodle gespeichert.
import Alpine from '../../vendor/alpinejs@3.17.5/dist/module.esm.js';
import { registerPlugin } from '../../core/plugin-registry.js';
import { SUPPLIERS, formatSemester, currentSemester, semesterYears, supplierLabel } from '../../core/config.js';
import { pb } from '../../core/pb.js';
import { listGroups, errorMessage } from '../../core/api.js';
import { toast, confirmAction } from '../../core/ui.js';
import {
  FIELDS, guessColumns, buildRows, distinctValues, suggestSupplier, suggestGroup, effectiveSupplier,
  checkRows, buildPayload, normalizePartNumber, parseQty, collapse,
} from './moodle-csv.js';

const PAPA_URL = new URL('../../vendor/papaparse@5.7.0/papaparse.min.js', import.meta.url).href;
let papaPromise = null;
function loadPapa() {
  papaPromise ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = PAPA_URL;
    el.onload = () => resolve(window.Papa);
    el.onerror = () => { papaPromise = null; reject(new Error('Papa Parse konnte nicht geladen werden.')); };
    document.head.appendChild(el);
  });
  return papaPromise;
}

const template = /* html */ `
<div x-data="moodleImporter" @open-moodle-import.window="open()" x-cloak>
  <div x-show="isOpen" class="fixed inset-0 z-40 flex flex-col bg-white" @keydown.escape.window="isOpen && close()">
    <div class="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
      <div class="min-w-0 flex-1">
        <h2 class="text-base font-semibold">Moodle-Import <span class="badge ml-1 bg-amber-50 text-amber-800 ring-amber-300 align-middle">Beta</span></h2>
        <p class="truncate text-xs text-slate-500" x-text="fileName || 'CSV-Export der Moodle-Datenbank'"></p>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" @click="close()">Schließen</button>
    </div>

    <div class="flex-1 overflow-y-auto">
      <div class="mx-auto max-w-4xl space-y-4 p-4">

        <!-- Schritt 1: Datei -->
        <section x-show="step === 'file'" class="space-y-3">
          <p class="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
            Testbetrieb: Bitte die Vorschau vor dem Buchen prüfen. Gebucht wird alles oder nichts.
          </p>
          <p class="text-sm text-slate-600">
            In Moodle die Datenbank-Aktivität öffnen → <em>Einträge exportieren</em> → Format <strong>CSV</strong> (Trennzeichen Komma).
            Die Datei hier auswählen oder hineinziehen.
          </p>
          <label class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 p-8 text-center hover:border-blue-400"
                 :class="dragOver && 'border-blue-500 bg-blue-50'"
                 @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent="dragOver = false; readFile($event.dataTransfer.files[0])">
            <span class="text-sm font-medium">CSV-Datei wählen</span>
            <span class="text-xs text-slate-500">oder hierher ziehen</span>
            <input type="file" accept=".csv,text/csv" class="hidden" data-moodle-file @change="readFile($event.target.files[0]); $event.target.value = ''">
          </label>
          <p x-show="busyText" class="text-sm text-blue-700" x-text="busyText"></p>
        </section>

        <!-- Schritt 2: Zuordnen -->
        <section x-show="step === 'map'" class="space-y-4">
          <div class="card space-y-3 p-3">
            <h3 class="text-sm font-semibold">Veranstaltung und Semester</h3>
            <p class="text-xs text-slate-500">Gilt für alle Gruppen dieses Imports; neue Gruppen werden hier angelegt.</p>
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
              <div class="col-span-2 sm:col-span-1">
                <label class="label" for="moodle-course">Veranstaltung</label>
                <input id="moodle-course" class="input" x-model="course" list="moodle-courses" maxlength="150" @change="courseChanged()">
                <datalist id="moodle-courses">
                  <template x-for="c in knownCourses()" :key="c"><option :value="c"></option></template>
                </datalist>
              </div>
              <div>
                <label class="label">Semester</label>
                <select class="input" x-model="term" @change="courseChanged()" aria-label="Semesterart">
                  <option value="WS">Wintersemester</option>
                  <option value="SS">Sommersemester</option>
                </select>
              </div>
              <div>
                <label class="label">&nbsp;</label>
                <select class="input" x-model.number="year" @change="courseChanged()" aria-label="Semesterjahr">
                  <template x-for="y in years()" :key="y">
                    <option :value="y" x-text="term === 'WS' ? y + '/' + String((y + 1) % 100).padStart(2, '0') : y"></option>
                  </template>
                </select>
              </div>
            </div>
          </div>

          <details class="card p-3" :open="missingColumns().length > 0">
            <summary class="cursor-pointer text-sm font-semibold">Spalten
              <span x-show="missingColumns().length" class="ml-1 text-red-700" x-text="'– fehlt: ' + missingColumns().join(', ')"></span>
            </summary>
            <div class="mt-3 grid gap-2 sm:grid-cols-2">
              <template x-for="f in fields" :key="f.key">
                <div>
                  <label class="label" x-text="f.label + (f.required ? '' : ' (optional)')"></label>
                  <select class="input" x-model.number="cols[f.key]" @change="rebuild()">
                    <option :value="-1">– keine –</option>
                    <template x-for="(h, i) in headers" :key="i"><option :value="i" x-text="h || ('Spalte ' + (i + 1))"></option></template>
                  </select>
                </div>
              </template>
            </div>
          </details>

          <div class="card p-3">
            <h3 class="mb-2 text-sm font-semibold">Lieferanten</h3>
            <ul class="space-y-2">
              <template x-for="s in supplierValues" :key="s.value">
                <li class="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_minmax(0,1fr)]">
                  <span class="text-sm"><span class="font-medium" x-text="s.value || '(leer)'"></span>
                    <span class="text-xs text-slate-500" x-text="'· ' + s.count + ' Zeile(n)'"></span></span>
                  <select class="input" x-model="supplierMap[s.value].supplier" @change="recheck()" :aria-label="'Lieferant für ' + s.value">
                    <option value="">– bitte wählen –</option>
                    <template x-for="o in suppliers" :key="o.value"><option :value="o.value" x-text="o.label"></option></template>
                  </select>
                  <input x-show="supplierMap[s.value].supplier === 'other'" class="input" x-model="supplierMap[s.value].supplier_custom_name"
                         @change="recheck()" placeholder="Shop-Name" maxlength="100" :aria-label="'Shop-Name für ' + s.value">
                </li>
              </template>
            </ul>
          </div>

          <div class="card p-3">
            <h3 class="mb-1 text-sm font-semibold">Gruppen</h3>
            <p class="mb-2 text-xs text-slate-500">Jede Gruppenbezeichnung aus Moodle einer Gruppe der Veranstaltung zuordnen oder neu anlegen. Vorschläge bitte prüfen.</p>
            <ul class="space-y-2">
              <template x-for="g in groupValues" :key="g.value">
                <li class="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <span class="text-sm break-words"><span class="font-medium" x-text="g.value || '(keine Gruppe angegeben)'"></span>
                    <span class="text-xs text-slate-500" x-text="'· ' + g.count + ' Zeile(n)'"></span>
                    <span x-show="groupSuggested[g.value]" class="badge ml-1 bg-blue-50 text-blue-800 ring-blue-200">Vorschlag</span></span>
                  <select class="input" x-model="groupMap[g.value]" @change="groupSuggested[g.value] = false; recheck()"
                          :class="!groupMap[g.value] && 'border-red-400'" :aria-label="'Gruppe für ' + (g.value || 'leer')">
                    <option value="">– bitte wählen –</option>
                    <option value="none">ohne Gruppe</option>
                    <template x-for="cg in courseGroups()" :key="cg.id"><option :value="'id:' + cg.id" x-text="cg.name"></option></template>
                    <template x-if="g.value"><option value="new" x-text="'neu anlegen: ' + g.value"></option></template>
                    <option value="rows">je Zeile in der Vorschau wählen</option>
                  </select>
                </li>
              </template>
            </ul>
          </div>

          <div class="flex flex-wrap justify-end gap-2 pb-6">
            <button type="button" class="btn btn-secondary" @click="step = 'file'">Andere Datei</button>
            <button type="button" class="btn btn-primary" :disabled="!canPreview()" @click="toPreview()">Weiter zur Vorschau</button>
          </div>
          <p x-show="!canPreview()" class="-mt-4 text-right text-xs text-slate-500" x-text="previewBlocker()"></p>
        </section>

        <!-- Schritt 3: Vorschau -->
        <section x-show="step === 'preview'" class="space-y-3">
          <p class="text-sm text-slate-600">
            <span x-text="includedCount() + ' von ' + rows.length + ' Zeilen ausgewählt'"></span>
            <span x-show="errorCount()" class="font-medium text-red-700" x-text="' · ' + errorCount() + ' mit Fehlern (bitte korrigieren oder abwählen)'"></span>
          </p>
          <ul class="space-y-2">
            <template x-for="row in rows" :key="row.line">
              <li class="card p-3" :class="{ 'opacity-50': !row.include, 'border-red-300': row.include && check(row).errors.length, 'border-amber-300': row.include && !check(row).errors.length && check(row).warnings.length }"
                  :data-line="row.line">
                <div class="flex flex-wrap items-start gap-2">
                  <label class="flex items-center gap-2 text-xs text-slate-500">
                    <input type="checkbox" x-model="row.include" @change="recheck()" :aria-label="'Zeile ' + row.line + ' übernehmen'">
                    <span x-text="'Zeile ' + row.line"></span>
                  </label>
                  <span class="text-xs text-slate-500" x-text="supplierText(row)"></span>
                </div>
                <div class="mt-2 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 sm:grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
                  <input class="input text-right" inputmode="numeric" x-model="row.qtyRaw" @change="row.qty = parseQty(row.qtyRaw); recheck()" aria-label="Anzahl">
                  <input class="input font-mono" x-model="row.part" @change="row.part = normalizePartNumber(row.part); recheck()" aria-label="Bestellnummer" spellcheck="false">
                  <input class="input col-span-2 sm:col-span-1" x-model="row.name" maxlength="300" placeholder="Bezeichnung (empfohlen)" aria-label="Bezeichnung">
                  <select class="input col-span-2 sm:col-span-1" x-model="row.groupChoice" @change="recheck()" aria-label="Gruppe">
                    <option value="" x-text="'wie zugeordnet: ' + mappedGroupText(row)"></option>
                    <option value="none">ohne Gruppe</option>
                    <template x-for="cg in courseGroups()" :key="cg.id"><option :value="'id:' + cg.id" x-text="cg.name"></option></template>
                    <template x-for="v in newGroupValues()" :key="v"><option :value="'new:' + v" x-text="'neu: ' + v"></option></template>
                  </select>
                </div>
                <p x-show="row.comment" class="mt-2 text-xs italic text-slate-500" x-text="'Moodle-Kommentar: ' + row.comment"></p>
                <template x-for="e in (row.include ? check(row).errors : [])" :key="e"><p class="mt-1 text-xs font-medium text-red-700" x-text="e"></p></template>
                <template x-for="w in (row.include ? check(row).warnings : [])" :key="w"><p class="mt-1 text-xs text-amber-800" x-text="w"></p></template>
              </li>
            </template>
          </ul>
          <div class="flex flex-wrap justify-end gap-2 pb-6">
            <button type="button" class="btn btn-secondary" @click="step = 'map'">Zurück zur Zuordnung</button>
            <button type="button" class="btn btn-success" :disabled="busy || !includedCount() || errorCount() > 0" @click="book()">
              <span x-text="busy ? 'Wird gebucht …' : includedCount() + ' Position(en) buchen'"></span>
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</div>`;

function component() {
  let records = [];
  let openItems = [];

  return {
    isOpen: false,
    step: 'file',
    busyText: '',
    busy: false,
    dragOver: false,
    fileName: '',
    fields: FIELDS,
    suppliers: SUPPLIERS,
    headers: [],
    cols: {},
    rows: [],
    allGroups: [],
    course: '',
    term: currentSemester().term,
    year: currentSemester().year,
    supplierValues: [],
    supplierMap: {},
    groupValues: [],
    groupMap: {},
    groupSuggested: {},
    checks: {},
    parseQty,
    normalizePartNumber,

    open() {
      this.reset();
      this.isOpen = true;
      loadPapa().catch((err) => toast.error(err.message));
    },

    close() {
      if (this.rows.length && !confirmAction('Import abbrechen? Die Zuordnung geht verloren.')) return;
      this.isOpen = false;
      this.reset();
    },

    reset() {
      records = [];
      openItems = [];
      const sem = currentSemester();
      Object.assign(this, {
        step: 'file', busyText: '', busy: false, dragOver: false, fileName: '', headers: [], cols: {}, rows: [],
        course: '', term: sem.term, year: sem.year, supplierValues: [], supplierMap: {}, groupValues: [], groupMap: {},
        groupSuggested: {}, checks: {},
      });
    },

    // ---- Datei ---------------------------------------------------------------
    async readFile(file) {
      if (!file) return;
      this.busyText = 'Datei wird gelesen …';
      try {
        const Papa = await loadPapa();
        const text = (await file.text()).replace(/^﻿/, '');
        const { data, errors } = Papa.parse(text, { skipEmptyLines: false });
        const fatal = errors.filter((e) => e.type === 'Quotes');
        if (fatal.length) throw new Error(`CSV fehlerhaft (Zeile ${fatal[0].row + 1}): ${fatal[0].message}`);
        const [headers = [], ...rest] = data;
        records = rest.filter((r) => !(r.length === 1 && r[0] === ''));
        if (!records.length) throw new Error('Die Datei enthält keine Einträge.');
        const [groups, items] = await Promise.all([
          listGroups(),
          pb.collection('order_items').getFullList({ filter: 'order.status = "angefragt"', expand: 'order' }),
        ]);
        this.allGroups = groups;
        openItems = items;
        this.fileName = file.name;
        this.headers = headers.map((h) => collapse(h));
        this.cols = guessColumns(this.headers);
        this.rebuild();
        this.step = 'map';
      } catch (err) {
        toast.error('Import nicht möglich: ' + errorMessage(err));
      } finally {
        this.busyText = '';
      }
    },

    /** Zeilen und Zuordnungstabellen aus Datei + Spaltenwahl neu aufbauen. */
    rebuild() {
      this.rows = buildRows(records, this.cols);
      this.supplierValues = distinctValues(this.rows, 'supplierRaw');
      const supplierMap = {};
      for (const { value } of this.supplierValues) supplierMap[value] = this.supplierMap[value] ?? suggestSupplier(value);
      this.supplierMap = supplierMap;
      this.groupValues = distinctValues(this.rows, 'groupRaw');
      this.suggestGroups(true);
    },

    // ---- Veranstaltung / Gruppen --------------------------------------------
    semester() { return formatSemester(this.term, this.year); },
    years() { return [...new Set([...semesterYears(), this.year])].sort((a, b) => a - b); },
    knownCourses() { return [...new Set(this.allGroups.map((g) => g.course))].sort((a, b) => a.localeCompare(b, 'de')); },
    courseGroups() {
      const course = collapse(this.course).toLowerCase();
      return this.allGroups
        .filter((g) => g.course.toLowerCase() === course && g.semester === this.semester())
        .sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
    },

    courseChanged() {
      this.suggestGroups(false);
    },

    /** Vorschläge setzen: beim Neuaufbau für alle, sonst nur für noch offene oder vorgeschlagene Zuordnungen. */
    suggestGroups(all) {
      const groups = this.courseGroups();
      const ids = new Set(groups.map((g) => 'id:' + g.id));
      const map = { ...this.groupMap };
      const suggested = { ...this.groupSuggested };
      for (const { value } of this.groupValues) {
        const current = map[value];
        const stale = current?.startsWith('id:') && !ids.has(current); // Gruppe gehört nicht (mehr) zur Veranstaltung
        if (all || !current || suggested[value] || stale) {
          const s = suggestGroup(value, groups);
          map[value] = s.choice;
          suggested[value] = s.suggested;
        }
      }
      this.groupMap = map;
      this.groupSuggested = suggested;
      for (const r of this.rows) if (r.groupChoice.startsWith('id:') && !ids.has(r.groupChoice)) r.groupChoice = '';
      this.recheck();
    },

    newGroupValues() {
      return this.groupValues.filter((g) => g.value && this.groupMap[g.value] === 'new').map((g) => g.value);
    },

    mappedGroupText(row) {
      const c = this.groupMap[row.groupRaw];
      if (c === 'none') return 'ohne Gruppe';
      if (c === 'new') return 'neu: ' + row.groupRaw;
      if (c === 'rows' || !c) return '– bitte wählen –';
      return this.allGroups.find((g) => 'id:' + g.id === c)?.name ?? '?';
    },

    missingColumns() {
      return FIELDS.filter((f) => f.required && !(this.cols[f.key] >= 0)).map((f) => f.label);
    },

    previewBlocker() {
      if (this.missingColumns().length) return 'Bitte die fehlenden Spalten zuordnen.';
      if (!collapse(this.course)) return 'Bitte die Veranstaltung angeben.';
      if (this.groupValues.some((g) => !this.groupMap[g.value])) return 'Bitte alle Gruppenbezeichnungen zuordnen.';
      return '';
    },
    canPreview() { return !this.previewBlocker(); },

    toPreview() {
      this.recheck();
      this.step = 'preview';
    },

    // ---- Vorschau ------------------------------------------------------------
    recheck() {
      const map = checkRows(this.rows, this.groupMap, this.supplierMap, openItems);
      this.checks = Object.fromEntries(map);
    },
    check(row) { return this.checks[row.line] ?? { errors: [], warnings: [] }; },
    includedCount() { return this.rows.filter((r) => r.include).length; },
    errorCount() { return this.rows.filter((r) => r.include && this.check(r).errors.length).length; },
    supplierText(row) {
      const s = effectiveSupplier(row, this.supplierMap);
      return s ? supplierLabel(s) : (row.supplierRaw || 'ohne Lieferant');
    },

    async book() {
      const payload = buildPayload(this.rows, this.groupMap, this.supplierMap, { course: this.course, semester: this.semester() });
      const newGroups = payload.groups.length ? `, ${payload.groups.length} neue Gruppe(n)` : '';
      if (!confirmAction(`${payload.items.length} Position(en) in die Sammel-Warenkörbe buchen${newGroups}?`)) return;
      this.busy = true;
      try {
        const r = await pb.send('/api/lab/cart-items/batch', { method: 'POST', body: payload });
        toast.success(`${r.items} Position(en) in ${r.orders} Warenkorb/Warenkörbe gebucht` +
          (r.merged ? `, ${r.merged} mit vorhandenen zusammengeführt` : '') + (r.groups ? `, ${r.groups} Gruppe(n) angelegt` : '') + '.');
        this.rows = [];
        this.isOpen = false;
        this.reset();
      } catch (err) {
        toast.error('Nichts gebucht: ' + errorMessage(err));
      } finally {
        this.busy = false;
      }
    },
  };
}

// ---- Einhängen ----------------------------------------------------------------
Alpine.data('moodleImporter', component);
const host = document.createElement('div');
host.innerHTML = template;
document.body.appendChild(host.firstElementChild);

registerPlugin({
  id: 'moodle-import',
  slot: 'dashboard-actions',
  label: 'Moodle-Import (Beta)',
  icon: 'upload',
  onClick: () => window.dispatchEvent(new CustomEvent('open-moodle-import')),
});
