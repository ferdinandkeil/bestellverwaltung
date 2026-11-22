// Verwaltungsschritte (ARCHITECTURE.md Kap. 4.3, Bedienung Kap. 7) – gemeinsam für Startseite (Tabelle) und Bestellung.
//
// „Handeln statt fragen“: Ein Klick hakt einen Schritt sofort ab bzw. entfernt den Haken; ein Toast nennt das Ergebnis
// (übersprungene Schritte, geschlossener Warenkorb) und bietet „Datum ändern“/„Rückgängig“. Ein Dialog erscheint nur,
// wenn die interne Bestellnummer fehlt, oder zum Ändern eines Datums. Nach jeder Änderung wird das Fenster-Ereignis
// `order-steps-changed` ausgelöst; Ansichten laden dann neu.
//
// Darstellung: quadratische Checkbox – Haken (erledigt), Strich (übersprungen), leer (offen).
import {
  STEP_TRACKS, WARE_STEPS, trackStates, stepMeta, supplierLabel, INTERNAL_ORDER_NO_RE, defaultWithoutInternalOrderNo,
} from '../core/config.js';
import { setOrderStep, errorMessage } from '../core/api.js';
import { fmt, toast } from '../core/ui.js';

const CHECK = '<svg viewBox="0 0 20 20" fill="currentColor" class="size-3.5" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" clip-rule="evenodd"/></svg>';

/**
 * Quadratische Checkbox eines Schritts `s` (aus stepView). Als Inhalt eines <button> bzw. <span> verwenden.
 * Klassen vollständig ausgeschrieben, damit der Tailwind-Build sie findet.
 */
export const STEP_BOX = /* html */ `
<span class="flex size-5 shrink-0 items-center justify-center rounded border"
      :class="{
        'border-emerald-600 bg-emerald-600 text-white': s.state === 'done',
        'border-slate-300 bg-slate-100 text-slate-500': s.state === 'skipped',
        'border-slate-400 bg-white': s.state === 'open' && s.clickable,
        'border-blue-600 ring-2 ring-blue-200': s.next,
        'border-slate-200 bg-slate-50': s.state === 'open' && !s.clickable,
      }">
  <template x-if="s.state === 'done'"><span>${CHECK}</span></template>
  <template x-if="s.state === 'skipped'"><span class="text-sm font-bold leading-none">–</span></template>
</span>`;

/** Heutiges Datum (lokal) als JJJJ-MM-TT. */
export function today() {
  return new Date().toLocaleDateString('sv-SE');
}

/** Datum aus PocketBase (UTC, „JJJJ-MM-TT hh:mm:ss.sssZ“) als lokales JJJJ-MM-TT. */
function localDay(value) {
  return value ? new Date(value.replace(' ', 'T')).toLocaleDateString('sv-SE') : '';
}

function whoAndWhen(record) {
  if (!record) return '';
  const who = record.expand?.done_by?.name || record.expand?.done_by?.email || '';
  const when = record.done_at ? fmt.date(record.done_at) : 'Datum unbekannt';
  return who ? `${when} · ${who}` : when;
}

/** Kurzname einer Bestellung für Meldungen, z. B. „Reichelt 2026IW01047“. */
function orderName(order) {
  return [supplierLabel(order), order.internal_order_no].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Zustände für die Anzeige
// ---------------------------------------------------------------------------

/**
 * Nächster sinnvoller Schritt (Hauptknopf der Bestellung, Hervorhebung): der erste offene nach dem zuletzt
 * erledigten. Die Freigabe ist meist nicht nötig → dann „bestellt“; ohne interne Nummer (Muster) direkt „bestellt“.
 */
export function nextStepOf(order, steps) {
  if (!order || order.status === 'abgeschlossen') return null;
  const [orderTrack, invoiceTrack] = STEP_TRACKS;
  const firstOpenAfterLast = (track) => {
    const states = trackStates(track, steps, order);
    const lastDone = states.map((s) => s.state).lastIndexOf('done');
    return states.find((s, i) => i > lastDone && s.state === 'open') || null;
  };
  if (!steps.ordered) {
    if (!order.internal_order_no && defaultWithoutInternalOrderNo(order)) return 'ordered';
    const candidate = firstOpenAfterLast(orderTrack);
    return !candidate || candidate.value === 'approval' ? 'ordered' : candidate.value;
  }
  const candidate = firstOpenAfterLast(invoiceTrack);
  return candidate && candidate.value !== 'closed' ? candidate.value : null;
}

/**
 * Spuren Bestellung, Ware, Rechnung mit Zustand je Schritt:
 * { value, label, short, state: done|skipped|open, record, detail, tooltip, clickable, disabledReason, next }.
 * deliveries: Lieferbuchungen der Bestellung (für „teilgeliefert“; mehr als eine Buchung = in Teilen geliefert).
 */
export function stepView(order, steps, deliveries = []) {
  if (!order) return [];
  const next = nextStepOf(order, steps);
  const ordered = !!steps.ordered;
  const delivered = ['geliefert', 'abgeschlossen'].includes(order.status);
  const noForm = !order.internal_order_no && !!order.without_internal_order_no;

  const decorate = (track) => trackStates(track, steps, order).map((s) => {
    let disabledReason = '';
    if (s.needsNumber && noForm && s.state !== 'done') disabledReason = 'Ohne interne Bestellnummer gibt es kein Formular.';
    else if (s.afterOrdered && !ordered && s.state !== 'done') disabledReason = 'Erst möglich, wenn die Bestellung bestellt ist.';
    else if (s.value === 'closed' && s.state !== 'done' && !delivered) disabledReason = 'Erst möglich, wenn die Ware vollständig geliefert ist.';
    else if (s.value === 'closed' && s.state === 'done' && !s.record) disabledReason = 'Automatisch abgeschlossen (Rechnung in Verwaltung).';
    let detail = '';
    if (s.state === 'done') detail = s.record ? whoAndWhen(s.record) : 'automatisch';
    else if (s.state === 'skipped') detail = 'übersprungen';
    else if (s.hint && s.value !== 'closed') detail = s.hint;
    const action = s.state === 'done' ? 'Klick entfernt den Haken' : 'Klick hakt ab (heute)';
    const tooltip = `${s.label}: ${detail || 'offen'}` + (disabledReason ? ` – ${disabledReason}` : ` – ${action}`);
    return { ...s, detail, tooltip, next: s.value === next, clickable: !disabledReason, disabledReason };
  });

  // Ware: aus den Lieferbuchungen
  const sorted = [...(deliveries || [])].sort((a, b) => a.created.localeCompare(b.created));
  const partial = order.status === 'teilgeliefert' || (delivered && sorted.length > 1);
  const ware = WARE_STEPS.map((w) => {
    let state = 'open';
    let detail = '';
    if (w.value === 'partial') {
      state = partial ? 'done' : delivered ? 'skipped' : 'open';
      detail = partial && sorted.length ? fmt.date(sorted[0].created) : delivered ? 'übersprungen' : '';
    } else if (delivered) {
      state = 'done';
      detail = fmt.date(order.delivered_at);
    }
    const disabledReason = 'Ergibt sich automatisch aus den Lieferbuchungen.';
    return { ...w, state, detail, record: null, next: false, clickable: false, disabledReason,
      tooltip: `${w.label}: ${detail || 'offen'} – ${disabledReason}` };
  });

  const [orderTrack, invoiceTrack] = STEP_TRACKS;
  return [
    { key: 'order', label: orderTrack.label, steps: decorate(orderTrack),
      hint: noForm ? 'Ohne interne Bestellnummer bestellt – kein Formular.' : '' },
    { key: 'ware', label: 'Ware', steps: ware, hint: 'automatisch aus den Lieferbuchungen' },
    { key: 'invoice', label: invoiceTrack.label, steps: decorate(invoiceTrack), hint: '' },
  ];
}

// ---------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------

function notifyChanged(order) {
  window.dispatchEvent(new CustomEvent('order-steps-changed', { detail: { orderId: order.id } }));
}

/** Schritt setzen; Fehler als Toast. → true bei Erfolg */
async function apply(order, step, options) {
  try {
    await setOrderStep(order.id, step, options);
    notifyChanged(order);
    return true;
  } catch (err) {
    toast.error(errorMessage(err));
    notifyChanged(order); // Anzeige auf den Stand des Servers bringen
    return false;
  }
}

/** Datum eines erledigten Schritts ändern (Dialog). */
export async function changeStepDate(order, value, current = '') {
  const meta = stepMeta(value);
  const result = await stepDialog().ask({ mode: 'date', title: `${meta.label}: Datum`, date: current || today() });
  if (!result) return;
  if (await apply(order, value, { done: true, date: result.date })) toast.success(`Datum von „${meta.label}“ geändert.`);
}

/**
 * Klick auf einen Schritt: abhaken (heute) bzw. Haken entfernen – sofort, mit Toast „Datum ändern“/„Rückgängig“.
 * steps: { step: record } der Bestellung (Stand vor dem Klick).
 */
export async function toggleStep(order, steps, value) {
  const meta = stepMeta(value);
  const name = orderName(order);
  const record = steps[value];

  if (record) {
    const previous = record.done_at ? localDay(record.done_at) : null; // null = Datum war unbekannt
    if (!(await apply(order, value, { done: false }))) return;
    toast.done(`„${meta.label}“ entfernt (${name}).`, [{
      label: 'Rückgängig',
      run: () => apply(order, value, { done: true, date: previous }),
    }]);
    return;
  }

  const options = {};
  if ((meta.needsNumber || value === 'ordered') && !order.internal_order_no) {
    if (value === 'ordered' && defaultWithoutInternalOrderNo(order)) {
      options.without_internal_order_no = true; // Muster (z. B. Würth): ohne Formular, wie voreingestellt
    } else {
      const input = await stepDialog().ask({ mode: 'number', title: meta.label, allowWithout: value === 'ordered' });
      if (!input) return;
      Object.assign(options, input.without ? { without_internal_order_no: true } : { internal_order_no: input.number });
    }
  }

  // Nebenwirkungen für die Meldung: übersprungene Schritte (Freigabe nicht erwähnen), geschlossener Warenkorb
  const states = trackStates(meta.track, steps, order);
  const index = states.findIndex((s) => s.value === value);
  const lastDone = states.map((s) => s.state).lastIndexOf('done');
  const skipped = index > lastDone
    ? states.slice(0, index).filter((s) => s.state === 'open' && s.value !== 'approval').map((s) => s.label)
    : [];
  const closesCart = order.status === 'angefragt' && meta.track.key === 'order';

  if (!(await apply(order, value, options))) return;
  let message = `„${meta.label}“ abgehakt (${name}).`;
  if (options.without_internal_order_no) message += ' Ohne interne Bestellnummer.';
  if (skipped.length) message += ` Übersprungen: ${skipped.join(', ')}.`;
  if (closesCart) message += ' Warenkorb geschlossen.';
  toast.done(message, [
    { label: 'Datum ändern', run: () => changeStepDate(order, value, today()) },
    { label: 'Rückgängig', run: () => apply(order, value, { done: false }) },
  ]);
}

// ---------------------------------------------------------------------------
// Dialog für fehlende Angaben bzw. Datum (einmal global eingehängt)
// ---------------------------------------------------------------------------

const DIALOG = /* html */ `
<div x-data x-cloak x-show="$store.stepDialog.open" x-transition.opacity class="modal-backdrop"
     @click.self="$store.stepDialog.close(null)" @keydown.escape.window="$store.stepDialog.open && $store.stepDialog.close(null)">
  <form class="modal-panel space-y-4" @submit.prevent="$store.stepDialog.submit()" data-step-dialog>
    <h2 class="text-lg font-semibold" x-text="$store.stepDialog.title"></h2>
    <template x-if="$store.stepDialog.mode === 'number'">
      <div>
        <label class="label" for="step-internal-no">Interne Bestellnummer</label>
        <input id="step-internal-no" class="input font-mono" x-model="$store.stepDialog.number" maxlength="11"
               placeholder="z. B. 2026IW01047" autocapitalize="characters" spellcheck="false"
               :disabled="$store.stepDialog.without">
        <template x-if="$store.stepDialog.allowWithout">
          <label class="mt-2 flex items-center gap-2 text-sm" data-step-without-internal-no>
            <input type="checkbox" x-model="$store.stepDialog.without"> ohne interne Bestellnummer (z. B. Muster, kein Formular)
          </label>
        </template>
      </div>
    </template>
    <template x-if="$store.stepDialog.mode === 'date'">
      <div>
        <label class="label" for="step-date">Datum</label>
        <input id="step-date" class="input" type="date" x-model="$store.stepDialog.date" :max="$store.stepDialog.max" required>
      </div>
    </template>
    <div class="flex justify-end gap-2">
      <button type="button" class="btn btn-secondary" @click="$store.stepDialog.close(null)">Abbrechen</button>
      <button type="submit" class="btn btn-primary" x-text="$store.stepDialog.mode === 'date' ? 'Speichern' : 'Abhaken'"></button>
    </div>
  </form>
</div>`;

let dialogStore = null;
function stepDialog() {
  return dialogStore;
}

function registerDialog(Alpine) {
  Alpine.store('stepDialog', {
    open: false, mode: 'number', title: '', number: '', without: false, allowWithout: false, date: '', max: '',
    resolve: null,
    ask({ mode, title, allowWithout = false, date = '' }) {
      this.close(null);
      Object.assign(this, { open: true, mode, title, number: '', without: false, allowWithout, date, max: today() });
      Alpine.nextTick(() => document.querySelector('[data-step-dialog] input:not([disabled])')?.focus());
      return new Promise((resolve) => { this.resolve = resolve; });
    },
    submit() {
      if (this.mode === 'date') {
        if (this.date) this.close({ date: this.date });
        return;
      }
      const number = this.number.trim().toUpperCase();
      if (!this.without && !INTERNAL_ORDER_NO_RE.test(number)) {
        toast.error('Die interne Bestellnummer hat das Format JJJJIW##### (z. B. 2026IW01047).');
        return;
      }
      this.close({ number, without: this.without });
    },
    close(result) {
      const resolve = this.resolve;
      this.resolve = null;
      this.open = false;
      resolve?.(result);
    },
  });
  dialogStore = Alpine.store('stepDialog');
  const host = document.createElement('div');
  host.innerHTML = DIALOG;
  document.body.appendChild(host.firstElementChild);
}

// ---------------------------------------------------------------------------
// Abschnitt „Ablauf“ in der Bestellung
// ---------------------------------------------------------------------------

/** Einbinden im Scope von `order`, `steps`, `deliveries`: <div x-data="orderSteps"> ${orderStepsSection} </div> */
export const orderStepsSection = /* html */ `
<section class="card p-4" data-order-steps>
  <h2 class="mb-3 text-lg font-semibold">Ablauf</h2>
  <div class="grid gap-5 md:grid-cols-3 md:gap-4">
    <template x-for="track in stepView(order, steps, deliveries)" :key="track.key">
      <div>
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500" x-text="track.label"></h3>
        <ol class="space-y-1">
          <template x-for="s in track.steps" :key="s.value">
            <li class="flex items-start gap-2.5 px-1 py-1">
              <button type="button" class="mt-0.5 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                      :class="s.clickable ? 'cursor-pointer' : 'cursor-default'" :disabled="!s.clickable"
                      :title="s.tooltip" :aria-label="s.tooltip" :data-step="s.value" :data-state="s.state"
                      @click="toggleStep(order, steps, s.value)">${STEP_BOX}</button>
              <span class="min-w-0 flex-1">
                <span class="block text-sm"
                      :class="{ 'font-medium text-slate-900': s.state === 'done' || s.next, 'text-slate-400': s.state === 'skipped' || (!s.clickable && s.state === 'open'), 'text-slate-700': s.state === 'open' && s.clickable && !s.next }"
                      x-text="s.label"></span>
                <template x-if="s.record">
                  <button type="button" class="block text-left text-xs text-slate-500 hover:text-blue-700 hover:underline"
                          title="Datum ändern" :data-step-date="s.value"
                          @click="changeStepDate(order, s.value, localDay(s.record.done_at))"
                          x-text="s.detail + (s.record.done_at ? '' : ' – eintragen')"></button>
                </template>
                <template x-if="!s.record && s.detail">
                  <span class="block text-xs text-slate-500" x-text="s.detail"></span>
                </template>
              </span>
            </li>
          </template>
        </ol>
        <p x-show="track.hint" class="hint mt-1 px-1" x-text="track.hint"></p>
      </div>
    </template>
  </div>
</section>`;

export function registerOrderSteps(Alpine) {
  registerDialog(Alpine);
  Alpine.data('orderSteps', () => ({
    stepView, nextStepOf, stepMeta, toggleStep, changeStepDate, localDay,
  }));
}
