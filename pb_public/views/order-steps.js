// Verwaltungsschritte einer Bestellung (ARCHITECTURE.md Kap. 4.3): drei Spuren (Bestellung, Ware, Rechnung),
// abhaken mit Datum, Datum korrigieren, zurücknehmen. Übersprungene Schritte erscheinen grau.
// Einbinden im Bestell-Detail innerhalb des Scopes von `order`, `steps`, `deliveries`:
//   <div x-data="orderSteps"> ${orderStepsSection} </div>   (+ ${orderStepDialog} innerhalb desselben x-data)
// Nach jeder Änderung wird `steps-changed` ausgelöst; der Aufrufer lädt dann neu.
import { STEP_TRACKS, trackStates, stepMeta, INTERNAL_ORDER_NO_RE, defaultWithoutInternalOrderNo } from '../core/config.js';
import { setOrderStep, errorMessage } from '../core/api.js';
import { fmt, toast, confirmAction } from '../core/ui.js';

const CHECK = '<svg viewBox="0 0 20 20" fill="currentColor" class="size-3.5" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" clip-rule="evenodd"/></svg>';

/** Schritt-Symbol: erledigt (grün), übersprungen (grau), offen, nächster Schritt (blau umrandet). */
const STEP_ICON = /* html */ `
<span class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full"
      :class="{
        'bg-emerald-600 text-white': s.state === 'done',
        'bg-slate-300 text-white': s.state === 'skipped',
        'bg-white ring-2 ring-blue-500': s.state === 'open' && s.next,
        'bg-white ring-2 ring-slate-300': s.state === 'open' && !s.next,
      }">
  <template x-if="s.state !== 'open'"><span>${CHECK}</span></template>
</span>`;

export const orderStepsSection = /* html */ `
<section class="card p-4" data-order-steps>
  <h2 class="mb-3 text-lg font-semibold">Ablauf</h2>
  <div class="grid gap-5 md:grid-cols-3 md:gap-4">
    <template x-for="track in tracks(order, steps, deliveries)" :key="track.key">
      <div>
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500" x-text="track.label"></h3>
        <ol class="space-y-1">
          <template x-for="s in track.steps" :key="s.value">
            <li>
              <button type="button" class="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition"
                      :class="s.clickable ? 'hover:bg-slate-50' : 'cursor-default'"
                      :disabled="!s.clickable" :title="s.disabledReason || ''"
                      :data-step="s.value" :data-state="s.state"
                      @click="s.clickable && openStep(s.value, order, steps)">
                ${STEP_ICON}
                <span class="min-w-0 flex-1">
                  <span class="block text-sm"
                        :class="{ 'font-medium text-slate-900': s.state === 'done' || s.next, 'text-slate-400': s.state === 'skipped' || (!s.clickable && s.state === 'open'), 'text-slate-700': s.state === 'open' && s.clickable && !s.next }"
                        x-text="s.label"></span>
                  <span class="block text-xs text-slate-500" x-show="s.detail" x-text="s.detail"></span>
                </span>
              </button>
            </li>
          </template>
        </ol>
        <p x-show="track.hint" class="hint mt-1 px-2" x-text="track.hint"></p>
      </div>
    </template>
  </div>
</section>`;

export const orderStepDialog = /* html */ `
<div x-show="dialog.open" x-transition.opacity class="modal-backdrop" @click.self="dialog.open = false"
     @keydown.escape.window="dialog.open && (dialog.open = false)">
  <form class="modal-panel space-y-4" @submit.prevent="submit(order)" data-step-dialog>
    <h2 class="text-lg font-semibold" x-text="dialog.label"></h2>

    <!-- Erledigt: Datum korrigieren oder zurücknehmen -->
    <template x-if="dialog.done">
      <div class="space-y-4">
        <p class="text-sm text-slate-700" x-text="dialog.doneText"></p>
        <template x-if="dialog.record">
          <div>
            <label class="label" for="step-date">Datum</label>
            <input id="step-date" class="input" type="date" x-model="dialog.date" :max="today()">
            <p class="hint">Datum korrigieren oder nachtragen.</p>
          </div>
        </template>
        <div class="flex flex-wrap gap-2">
          <template x-if="dialog.record">
            <button type="button" class="btn btn-danger" :disabled="stepBusy" @click="undo(order, steps)">Zurücknehmen</button>
          </template>
          <span class="flex-1"></span>
          <button type="button" class="btn btn-secondary" @click="dialog.open = false">Schließen</button>
          <template x-if="dialog.record">
            <button type="submit" class="btn btn-primary" :disabled="stepBusy || !dialog.date">Datum speichern</button>
          </template>
        </div>
      </div>
    </template>

    <!-- Offen oder übersprungen: abhaken -->
    <template x-if="!dialog.done">
      <div class="space-y-4">
        <p x-show="dialog.skipping.length" class="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-step-skipping
           x-text="'Noch offen und wird übersprungen: ' + dialog.skipping.join(', ') + '.'"></p>
        <p x-show="dialog.closesCart" class="text-sm text-slate-600">
          Der Warenkorb wird damit geschlossen. Neue Positionen für diesen Lieferanten landen in einem neuen Warenkorb.
        </p>

        <template x-if="dialog.askNumber">
          <div>
            <label class="label" for="step-internal-no">Interne Bestellnummer</label>
            <input id="step-internal-no" class="input font-mono" x-model="dialog.internal_order_no" maxlength="11"
                   placeholder="z. B. 2026IW01047" autocapitalize="characters" spellcheck="false"
                   :disabled="dialog.without" :required="!dialog.without">
            <template x-if="dialog.step === 'ordered'">
              <label class="mt-2 flex items-center gap-2 text-sm" data-step-without-internal-no>
                <input type="checkbox" x-model="dialog.without"> ohne interne Bestellnummer (z. B. Muster, kein Formular)
              </label>
            </template>
          </div>
        </template>

        <template x-if="dialog.step === 'ordered'">
          <div>
            <label class="label" for="step-supplier-no">Auftragsnummer des Shops <span class="font-normal text-slate-500">(optional)</span></label>
            <input id="step-supplier-no" class="input" x-model="dialog.supplier_order_no" maxlength="100" placeholder="aus der Bestellbestätigung">
          </div>
        </template>

        <div>
          <label class="label" for="step-date">Datum</label>
          <input id="step-date" class="input" type="date" x-model="dialog.date" :max="today()" required>
        </div>

        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-secondary" @click="dialog.open = false">Abbrechen</button>
          <button type="submit" class="btn btn-primary" :disabled="stepBusy" x-text="dialog.submitLabel"></button>
        </div>
      </div>
    </template>
  </form>
</div>`;

/** Heutiges Datum (lokal) als JJJJ-MM-TT. */
function today() {
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

function emptyDialog() {
  return {
    open: false, step: '', label: '', done: false, record: null, doneText: '', date: '', skipping: [],
    closesCart: false, askNumber: false, internal_order_no: '', without: false, supplier_order_no: '', submitLabel: 'Abhaken',
  };
}

export function registerOrderSteps(Alpine) {
  Alpine.data('orderSteps', () => ({
    dialog: emptyDialog(),
    stepBusy: false, // eigener Name: liegt im Scope des Bestell-Details (dort „busy“)
    today,

    /** Spuren für die Anzeige: Bestellung, Ware (aus den Lieferungen), Rechnung – je Schritt Zustand und Text. */
    tracks(order, steps, deliveries) {
      if (!order) return [];
      const next = this.nextStep(order, steps);
      const ordered = !!steps.ordered;
      const delivered = ['geliefert', 'abgeschlossen'].includes(order.status);
      const noForm = !order.internal_order_no && !!order.without_internal_order_no;

      const decorate = (track) => trackStates(track, steps, order).map((s) => {
        let disabledReason = '';
        if (s.needsNumber && noForm && s.state !== 'done') disabledReason = 'Ohne interne Bestellnummer gibt es kein Formular.';
        else if (s.afterOrdered && !ordered) disabledReason = 'Erst möglich, wenn die Bestellung bestellt ist.';
        else if (s.value === 'closed' && s.state !== 'done' && !delivered) disabledReason = 'Erst möglich, wenn die Ware vollständig geliefert ist.';
        else if (s.value === 'closed' && s.state === 'done' && !s.record) disabledReason = 'Automatisch abgeschlossen (Rechnung in Verwaltung).';
        let detail = '';
        if (s.state === 'done') detail = s.record ? whoAndWhen(s.record) : 'automatisch';
        else if (s.state === 'skipped') detail = 'übersprungen';
        else if (s.hint && s.value !== 'closed') detail = s.hint;
        return { ...s, detail, next: s.value === next, clickable: !disabledReason, disabledReason };
      });

      // Ware: aus den Lieferbuchungen; „teilgeliefert“ übersprungen, wenn alles auf einmal kam
      const positive = (deliveries || []).filter((d) => (d.expand?.delivery_items_via_delivery ?? []).some((l) => l.qty > 0));
      const first = positive.length ? positive[positive.length - 1] : null; // Liste ist absteigend sortiert
      const partial = order.status === 'teilgeliefert' || (delivered && positive.length > 1);
      const ware = [
        { value: 'partial', label: 'Teilgeliefert', state: partial ? 'done' : delivered ? 'skipped' : 'open',
          detail: partial && first ? fmt.date(first.created) : delivered ? 'übersprungen' : '' },
        { value: 'delivered', label: 'Geliefert', state: delivered ? 'done' : 'open',
          detail: delivered ? fmt.date(order.delivered_at) : '' },
      ].map((s) => ({ ...s, next: false, clickable: false, disabledReason: 'Ergibt sich automatisch aus den Lieferbuchungen.' }));

      const [orderTrack, invoiceTrack] = STEP_TRACKS;
      return [
        { key: 'order', label: orderTrack.label, steps: decorate(orderTrack),
          hint: noForm ? 'Ohne interne Bestellnummer bestellt – kein Formular.' : '' },
        { key: 'ware', label: 'Ware', steps: ware, hint: 'automatisch aus den Lieferbuchungen' },
        { key: 'invoice', label: invoiceTrack.label, steps: decorate(invoiceTrack), hint: '' },
      ];
    },

    /**
     * Nächster sinnvoller Schritt (für den Hauptknopf): der erste offene nach dem zuletzt erledigten.
     * Die Freigabe ist meist nicht nötig → dann „bestellt“; ohne interne Nummer direkt „bestellt“.
     */
    nextStep(order, steps) {
      if (!order || order.status === 'abgeschlossen') return null;
      const [orderTrack, invoiceTrack] = STEP_TRACKS;
      if (!steps.ordered) {
        if (!order.internal_order_no && defaultWithoutInternalOrderNo(order)) return 'ordered';
        const states = trackStates(orderTrack, steps, order);
        const lastDone = states.map((s) => s.state).lastIndexOf('done');
        const candidate = states.find((s, i) => i > lastDone && s.state === 'open');
        return !candidate || candidate.value === 'approval' ? 'ordered' : candidate.value;
      }
      const states = trackStates(invoiceTrack, steps, order);
      const lastDone = states.map((s) => s.state).lastIndexOf('done');
      const candidate = states.find((s, i) => i > lastDone && s.state === 'open');
      return candidate && candidate.value !== 'closed' ? candidate.value : null;
    },

    openStep(value, order, steps) {
      const meta = stepMeta(value);
      const track = meta.track;
      const states = trackStates(track, steps, order);
      const index = states.findIndex((s) => s.value === value);
      const own = states[index];
      const d = emptyDialog();
      Object.assign(d, { open: true, step: value, label: meta.label, record: own.record, done: own.state === 'done' });

      if (d.done) {
        d.doneText = own.record ? 'Erledigt: ' + whoAndWhen(own.record) + '.' : 'Automatisch abgeschlossen (Rechnung in Verwaltung).';
        d.date = localDay(own.record?.done_at);
      } else {
        d.date = today();
        // offene Schritte davor, die mit diesem Schritt als übersprungen gelten (Freigabe ist meist nicht nötig: nicht erwähnen)
        const lastDone = states.map((s) => s.state).lastIndexOf('done');
        d.skipping = index > lastDone
          ? states.slice(0, index).filter((s) => s.state === 'open' && s.value !== 'approval').map((s) => s.label)
          : [];
        d.closesCart = order.status === 'angefragt' && track.key === 'order';
        d.askNumber = (meta.needsNumber || value === 'ordered') && !order.internal_order_no;
        d.without = value === 'ordered' && defaultWithoutInternalOrderNo(order);
        d.supplier_order_no = order.supplier_order_no || '';
        d.submitLabel = own.state === 'skipped' ? 'Nachtragen' : 'Abhaken';
      }
      this.dialog = d;
      this.$nextTick(() => document.querySelector('[data-step-dialog] input:not([disabled])')?.focus());
    },

    async submit(order) {
      const d = this.dialog;
      const options = { done: true, date: d.date === today() && !d.done ? '' : d.date };
      if (!d.done) {
        if (d.askNumber && !d.without) {
          const no = d.internal_order_no.trim().toUpperCase();
          if (!INTERNAL_ORDER_NO_RE.test(no)) {
            toast.error('Die interne Bestellnummer hat das Format JJJJIW##### (z. B. 2026IW01047).');
            return;
          }
          options.internal_order_no = no;
        }
        if (d.askNumber && d.without) options.without_internal_order_no = true;
        if (d.step === 'ordered') options.supplier_order_no = d.supplier_order_no.trim();
      }
      await this.send(order, d.step, options, d.done ? 'Datum gespeichert.' : `„${d.label}“ abgehakt.`);
    },

    async undo(order, steps) {
      const d = this.dialog;
      const orderTrack = STEP_TRACKS[0].steps.map((s) => s.value);
      const reopensCart = orderTrack.includes(d.step) && orderTrack.every((v) => v === d.step || !steps[v]);
      const msg = `„${d.label}“ zurücknehmen?` +
        (reopensCart ? ' Danach ist kein Schritt der Bestellung mehr erledigt – der Warenkorb wird wieder geöffnet.' : '');
      if (!(await confirmAction(msg, { confirmLabel: 'Zurücknehmen' }))) return;
      await this.send(order, d.step, { done: false }, `„${d.label}“ zurückgenommen.`);
    },

    async send(order, step, options, success) {
      this.stepBusy = true;
      try {
        await setOrderStep(order.id, step, options);
        this.dialog.open = false;
        toast.success(success);
        this.$dispatch('steps-changed');
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.stepBusy = false;
      }
    },
  }));
}
