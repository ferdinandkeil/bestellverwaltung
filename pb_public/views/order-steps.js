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
import { setOrderStep, bookRestDelivered, cancelDelivery, errorMessage } from '../core/api.js';
import { fmt, toast, TOOLTIP_DELAY_MS, TOOLTIP_WARM_MS } from '../core/ui.js';

export const CHECK = '<svg viewBox="0 0 20 20" fill="currentColor" class="size-3.5" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" clip-rule="evenodd"/></svg>';

/**
 * Quadratische Checkbox eines Schritts `s` (aus stepView). Als Inhalt eines <button> bzw. <span> verwenden.
 * Klassen vollständig ausgeschrieben, damit der Tailwind-Build sie findet.
 */
export const STEP_BOX = /* html */ `
<span class="flex size-5 shrink-0 items-center justify-center rounded border" data-step-box
      :class="{
        'border-emerald-600 bg-emerald-600 text-white': s.state === 'done',
        'border-slate-300 bg-slate-100 text-slate-500': s.state === 'skipped',
        'border-slate-400 bg-white': s.state === 'open' && s.clickable,
        'border-blue-600 ring-2 ring-blue-200': s.next,
        'border-slate-200 bg-slate-50': s.state === 'open' && !s.clickable,
      }">
  <template x-if="s.state === 'done'"><span>${CHECK}</span></template>
  <template x-if="s.state === 'skipped'"><span class="text-sm font-bold leading-none">–</span></template>
  <!-- Vorschau: leeres, klickbares Kästchen zeigt beim Überfahren des Knopfs (group/step) sofort ein graues Häkchen -->
  <template x-if="s.state === 'open' && s.clickable">
    <span class="text-slate-400 opacity-0 group-hover/step:opacity-100">${CHECK}</span>
  </template>
</span>`;

/** Heutiges Datum (lokal) als JJJJ-MM-TT. */
export function today() {
  return new Date().toLocaleDateString('sv-SE');
}

/** Datum aus PocketBase (UTC, „JJJJ-MM-TT hh:mm:ss.sssZ“) als lokales JJJJ-MM-TT. */
function localDay(value) {
  return value ? new Date(value.replace(' ', 'T')).toLocaleDateString('sv-SE') : '';
}

/** Tooltip für erledigte Schritte ohne bekanntes Datum (z. B. aus der Migration). */
const NO_DATE = 'kein Datum';

function whoAndWhen(record) {
  if (!record) return '';
  const who = record.expand?.done_by?.name || record.expand?.done_by?.email || '';
  const when = record.done_at ? fmt.date(record.done_at) : NO_DATE;
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
 * Nächste sinnvolle Schritte (Hauptknöpfe der Bestellung, Hervorhebung): je Spur der erste offene nach dem zuletzt
 * erledigten. Vor „bestellt“ nur die Spur Bestellung; die Freigabe ist meist nicht nötig → dann „bestellt“, ohne
 * interne Nummer (Muster) direkt „bestellt“. Nach „bestellt“ laufen Ware und Rechnung gleichzeitig: „Geliefert“
 * (solange Ware offen ist) und der nächste Rechnungsschritt.
 */
export function nextStepsOf(order, steps) {
  if (!order || order.status === 'abgeschlossen') return [];
  const [orderTrack, invoiceTrack] = STEP_TRACKS;
  const firstOpenAfterLast = (track) => {
    const states = trackStates(track, steps, order);
    const lastDone = states.map((s) => s.state).lastIndexOf('done');
    return states.find((s, i) => i > lastDone && s.state === 'open') || null;
  };
  if (!steps.ordered) {
    if (!order.internal_order_no && defaultWithoutInternalOrderNo(order)) return ['ordered'];
    const candidate = firstOpenAfterLast(orderTrack);
    return [!candidate || candidate.value === 'approval' ? 'ordered' : candidate.value];
  }
  const next = [];
  if (['bestellt', 'teilgeliefert'].includes(order.status)) next.push('delivered');
  const invoice = firstOpenAfterLast(invoiceTrack);
  if (invoice && invoice.value !== 'closed') next.push(invoice.value);
  return next;
}

/**
 * Spuren Bestellung, Ware, Rechnung mit Zustand je Schritt:
 * { value, label, short, state: done|skipped|open, record, detail, tip, ariaLabel, clickable, disabledReason, next }.
 * tip: Tooltip am Kästchen – nur das Datum erledigter Schritte („kein Datum“, wenn unbekannt), sonst leer.
 * tipLong: wie tip, zusätzlich mit Nutzer („Datum · Name“) – für den Ablauf in der Bestellung.
 * deliveries: Lieferbuchungen der Bestellung (für „teilgeliefert“; mehr als eine Buchung = in Teilen geliefert).
 */
export function stepView(order, steps, deliveries = []) {
  if (!order) return [];
  const next = nextStepsOf(order, steps);
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
    let tip = '';
    if (s.state === 'done') tip = s.record ? (s.record.done_at ? fmt.date(s.record.done_at) : NO_DATE) : (fmt.date(order.closed_at) || NO_DATE);
    const ariaLabel = `${s.label}: ${tip || (s.state === 'skipped' ? 'übersprungen' : 'offen')}`;
    // Ablauf in der Bestellung: Tooltip mit Datum und Nutzer (Startseite: nur Datum)
    const tipLong = s.state === 'done' && s.record ? whoAndWhen(s.record) : tip;
    return { ...s, detail, tip, tipLong, ariaLabel, next: next.includes(s.value), clickable: !disabledReason, disabledReason };
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
    // „Geliefert“ abhaken bucht den Rest aller Positionen (deliverRest); „Teilgeliefert“ ergibt sich nur aus Buchungen.
    const canDeliverRest = w.value === 'delivered' && state === 'open' && ['bestellt', 'teilgeliefert'].includes(order.status);
    const disabledReason = canDeliverRest ? '' : 'Ergibt sich aus den Lieferbuchungen.';
    const tip = state === 'done' ? detail || NO_DATE : '';
    return { ...w, state, detail, tip, tipLong: tip, ariaLabel: `${w.label}: ${tip || (state === 'skipped' ? 'übersprungen' : 'offen')}`,
      record: null, next: next.includes(w.value), clickable: canDeliverRest, disabledReason };
  });

  const [orderTrack, invoiceTrack] = STEP_TRACKS;
  return [
    { key: 'order', label: orderTrack.label, steps: decorate(orderTrack),
      hint: noForm ? 'Ohne interne Bestellnummer bestellt – kein Formular.' : '' },
    { key: 'ware', label: 'Ware', steps: ware, hint: '' },
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
  if (value === 'delivered') return deliverRest(order);
  const meta = stepMeta(value);
  const name = orderName(order);
  const record = steps[value];

  if (record) {
    const previous = record.done_at ? localDay(record.done_at) : null; // null = Datum war unbekannt
    if (!(await apply(order, value, { done: false }))) return;
    toast.done(`„${meta.label}“ entfernt (${name}).`, [{
      label: 'Rückgängig',
      icon: 'undo',
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
    { label: 'Datum ändern', icon: 'calendar', run: () => changeStepDate(order, value, today()) },
    { label: 'Rückgängig', icon: 'undo', run: () => apply(order, value, { done: false }) },
  ]);
}

/**
 * „Geliefert“ abhaken: Rest aller Positionen sofort als eine Lieferung buchen; „Rückgängig“ nimmt die Buchung zurück.
 */
async function deliverRest(order) {
  const name = orderName(order);
  let result;
  try {
    result = await bookRestDelivered(order.id);
  } catch (err) {
    toast.error(errorMessage(err));
    notifyChanged(order);
    return;
  }
  notifyChanged(order);
  toast.done(`„Geliefert“ abgehakt – alle Positionen vollständig geliefert gebucht (${name}).`, [{
    label: 'Rückgängig',
    icon: 'undo',
    run: async () => {
      try {
        await cancelDelivery(result.delivery.id);
      } catch (err) {
        toast.error(errorMessage(err));
      }
      notifyChanged(order);
    },
  }]);
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
/** Symbole im Ablauf: Stift (PC, Datum ändern) und Lupe (Smartphone, Details). */
const PENCIL = '<svg viewBox="0 0 20 20" fill="currentColor" class="size-4" aria-hidden="true"><path d="M13.6 3.2a2 2 0 0 1 2.8 2.8l-.8.8-2.8-2.8.8-.8ZM11.7 5.1l2.8 2.8-7.6 7.6-3.4.6.6-3.4 7.6-7.6Z"/></svg>';
const MAGNIFIER = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="size-5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m12.5 12.5 4.5 4.5"/></svg>';

export const orderStepsSection = /* html */ `
<section class="card p-4" data-order-steps>
  <h2 class="mb-3 text-lg font-semibold">Ablauf</h2>
  <!-- Linien zwischen den Kästchen: SVG darüber, aus den Positionen der Kästchen gezeichnet (stepLines) -->
  <div class="relative" x-data="stepLines" x-effect="stepView(order, steps, deliveries); $nextTick(() => draw())">
    <svg class="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden="true" x-ref="lines" data-step-lines></svg>
    <div class="relative grid gap-5 md:grid-cols-3 md:gap-8 md:pb-6">
      <template x-for="track in stepView(order, steps, deliveries)" :key="track.key">
        <div data-track>
          <!-- Überschrift eingerückt: links läuft die Linie durch (Smartphone: Spuren untereinander) -->
          <h3 class="pl-[2.125rem] text-xs font-semibold uppercase tracking-wide text-slate-500" x-text="track.label"></h3>
          <p x-show="track.hint" class="pl-[2.125rem] text-xs text-slate-500" x-text="track.hint"></p>
          <ol class="mt-2 space-y-3">
            <template x-for="s in track.steps" :key="s.value">
              <li class="px-1" x-data="stepItem">
                <!-- offen und klickbar: Kästchen und Text sind ein Knopf (Überfahren zeigt das graue Vorschau-Häkchen) -->
                <template x-if="s.state === 'open' && s.clickable">
                  <button type="button" class="group/step flex cursor-pointer items-center gap-2.5 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                          :aria-label="s.ariaLabel" :data-step="s.value" :data-state="s.state" @click="toggleStep(order, steps, s.value)">
                    ${STEP_BOX}
                    <span class="text-sm" x-text="s.label" :data-step-label="s.value"
                          :class="s.next ? 'font-semibold text-slate-900' : 'text-slate-700'"></span>
                  </button>
                </template>
                <template x-if="!(s.state === 'open' && s.clickable)">
                <div class="flex items-center gap-2.5">
                  <button type="button" class="group/step relative rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                          :class="s.clickable ? 'cursor-pointer' : 'cursor-default'" :aria-disabled="!s.clickable"
                          x-tip="s.tipLong" :aria-label="s.ariaLabel" :data-step="s.value" :data-state="s.state"
                          @click="s.clickable && toggleStep(order, steps, s.value)">${STEP_BOX}</button>
                  <span class="flex min-w-0 flex-1 items-center gap-1">
                    <!-- PC: Beschriftung eines erledigten Schritts ist mit dem Stift ein Knopf; nach kurzem Verweilen
                         blau, unterstrichen, Stift sichtbar, dann ändert ein Klick das Datum. Fett nur die nächsten Schritte. -->
                    <template x-if="s.record">
                      <button type="button" class="inline-flex items-center gap-1 rounded text-left focus-visible:outline-2 focus-visible:outline-blue-600"
                              :class="editable ? 'cursor-pointer text-blue-700' : 'cursor-default'"
                              @mouseenter="hoverStart(s)" @mouseleave="hoverEnd()" @focus="editable = isDesktop()" @blur="hoverEnd()"
                              @click="editable && changeStepDate(order, s.value, localDay(s.record.done_at))"
                              :aria-label="s.label + ': Datum ändern'" :data-step-label="s.value">
                        <span class="text-sm" x-text="s.label"
                              :class="editable ? 'underline underline-offset-2' : (s.next ? 'font-semibold text-slate-900' : 'text-slate-700')"></span>
                        <span class="hidden md:inline-flex" :class="editable ? 'opacity-100' : 'opacity-0'" :data-step-edit="s.value">${PENCIL}</span>
                      </button>
                    </template>
                    <template x-if="!s.record">
                      <span class="text-sm" x-text="s.label" :data-step-label="s.value"
                            :class="s.state === 'done' ? 'text-slate-700' : 'text-slate-400'"></span>
                    </template>
                    <!-- Smartphone: Lupe → Details (Datum, Person) mit „Datum ändern“ -->
                    <template x-if="s.state === 'done'">
                      <button type="button" class="-my-1 ml-auto rounded p-1.5 text-slate-400 active:text-blue-700 md:hidden"
                              @click="info = !info" :aria-expanded="info" :aria-label="s.label + ': Details'" :data-step-info="s.value">${MAGNIFIER}</button>
                    </template>
                  </span>
                </div>
                </template>
                <div x-show="info" x-transition class="mt-1 ml-[1.875rem] flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm md:hidden"
                     :data-step-details="s.value">
                  <span class="mr-auto text-slate-700" x-text="s.tipLong"></span>
                  <template x-if="s.record">
                    <button type="button" class="font-medium text-blue-700" :data-step-date="s.value"
                            @click="changeStepDate(order, s.value, localDay(s.record.done_at))">Datum ändern</button>
                  </template>
                </div>
              </li>
            </template>
          </ol>
        </div>
      </template>
    </div>
  </div>
</section>`;

/** Ablauf-Linien: ein Stück gilt als erreicht, sobald das Kästchen, zu dem es führt, erledigt oder übersprungen ist. */
const LINE_RADIUS = 12;   // Rundung der Bögen zwischen den Spuren
const LINE_DROP = 10;     // Abstand unter dem letzten Eintrag einer Spur (inkl. Datum), auf dem der Bogen verläuft

/**
 * Zeichnet die Verbindungen als SVG-Pfade: in einer Spur senkrecht von Kästchen zu Kästchen. Ab „Bestellt“ zweigt
 * die Linie ab – zu „Teilgeliefert“ (Ware) und zu „Rechnung da“ (Ware und Rechnung laufen gleichzeitig): ein
 * gemeinsamer Strang unter den Spalten, von dem Bögen durch die Lücken zwischen den Spalten nach oben führen.
 * Stehen die Spuren untereinander (Smartphone), läuft die Linie gerade weiter.
 * Offen: dünn, schwarz. Erreicht (Ziel-Kästchen erledigt oder übersprungen): dicker, grün, leichter Schatten.
 */
function stepLines() {
  return {
    observer: null,
    init() {
      this.observer = new ResizeObserver(() => this.draw());
      this.observer.observe(this.$el);
    },
    destroy() {
      this.observer?.disconnect();
    },
    draw() {
      const svg = this.$refs.lines;
      if (!svg) return;
      const base = this.$el.getBoundingClientRect();
      const rel = (r) => ({
        left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top,
        cx: r.left - base.left + r.width / 2, cy: r.top - base.top + r.height / 2,
      });
      const tracks = [...this.$el.querySelectorAll('[data-track]')].map((col) => ({
        ...rel(col.getBoundingClientRect()),
        boxes: [...col.querySelectorAll('[data-step]')].map((el) => ({
          ...rel(el.querySelector('[data-step-box]').getBoundingClientRect()),
          itemBottom: rel(el.closest('li').getBoundingClientRect()).bottom,
          reached: el.dataset.state === 'done' || el.dataset.state === 'skipped',
        })),
      })).filter((t) => t.boxes.length);
      const lines = []; // { d, reached }
      const straight = (a, b) => lines.push({ d: `M${a.cx} ${a.bottom} L${b.cx} ${b.top}`, reached: b.reached });
      for (const t of tracks) for (let i = 1; i < t.boxes.length; i++) straight(t.boxes[i - 1], t.boxes[i]);

      const [order, ...rest] = tracks;
      const from = order?.boxes.at(-1); // „Bestellt“
      if (from && rest.length) {
        const sideBySide = Math.abs(rest[0].boxes[0].cx - from.cx) > 2;
        if (!sideBySide) {
          // untereinander: gerade weiter von Spur zu Spur
          let prev = from;
          for (const t of rest) { straight(prev, t.boxes[0]); prev = t.boxes.at(-1); }
        } else {
          // Gemeinsamer Strang auf einer Höhe unter allen Spalten, die er unterquert; je Ziel ein Bogen durch die
          // Lücke vor dessen Spalte nach oben.
          const r = LINE_RADIUS;
          const y = Math.max(...[order, ...rest.slice(0, -1)].map((t) => t.boxes.at(-1).itemBottom)) + LINE_DROP;
          let prevCol = order;
          for (const t of rest) {
            const gap = (prevCol.right + t.left) / 2;
            const to = t.boxes[0];
            lines.push({
              reached: to.reached,
              d: `M${from.cx} ${from.bottom} L${from.cx} ${y - r} Q${from.cx} ${y} ${from.cx + r} ${y} L${gap - r} ${y} `
                + `Q${gap} ${y} ${gap} ${y - r} L${gap} ${to.cy + r} Q${gap} ${to.cy} ${gap + r} ${to.cy} L${to.left} ${to.cy}`,
            });
            prevCol = t;
          }
        }
      }
      // offene zuerst, erreichte darüber (gemeinsame Stücke erscheinen grün, sobald ein Ziel erreicht ist)
      lines.sort((a, b) => Number(a.reached) - Number(b.reached));
      svg.innerHTML = lines.map((l) => `<path d="${l.d}" class="${l.reached ? 'step-line step-line-reached' : 'step-line'}"/>`).join('');
    },
  };
}

/**
 * „Datum ändern“ über der Beschriftung: dieselbe Logik wie Tooltips – erst nach TOOLTIP_DELAY_MS Verweilen; wer
 * innerhalb von TOOLTIP_WARM_MS zur nächsten Beschriftung wechselt, bekommt es sofort.
 */
let editShown = false;  // gerade eine Beschriftung im Bearbeiten-Zustand
let editHiddenAt = 0;   // Zeitpunkt, zu dem der letzte Bearbeiten-Zustand endete

/** Ein Schritt im Ablauf: Lupe (Smartphone) und „Datum ändern“ nach Verweilen über der Beschriftung (PC). */
function stepItem() {
  return {
    info: false,
    editable: false,
    hoverTimer: null,
    /** PC (ab md, kein Touch-Zeiger); auf dem Smartphone gibt es dafür die Lupe. */
    isDesktop() {
      return window.matchMedia('(min-width: 48rem)').matches && !window.matchMedia('(pointer: coarse)').matches;
    },
    hoverStart(s) {
      clearTimeout(this.hoverTimer);
      if (!s.record || !this.isDesktop()) return;
      const show = () => { this.editable = true; editShown = true; };
      if (editShown || Date.now() - editHiddenAt < TOOLTIP_WARM_MS) show();
      else this.hoverTimer = setTimeout(show, TOOLTIP_DELAY_MS);
    },
    hoverEnd() {
      clearTimeout(this.hoverTimer);
      if (this.editable) {
        editShown = false;
        editHiddenAt = Date.now();
      }
      this.editable = false;
    },
    destroy() {
      clearTimeout(this.hoverTimer);
    },
  };
}

export function registerOrderSteps(Alpine) {
  registerDialog(Alpine);
  Alpine.data('stepItem', stepItem);
  Alpine.data('stepLines', stepLines);
  Alpine.data('orderSteps', () => ({
    stepView, nextStepsOf, stepMeta, toggleStep, changeStepDate, localDay,
  }));
}
