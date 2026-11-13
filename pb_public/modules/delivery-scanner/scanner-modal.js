// Lieferschein-Erfassung: Fotos aufnehmen → Ecken prüfen/entzerren → Texterkennung → Abgleich prüfen → buchen.
// Registriert sich in den Slots 'order-detail-actions' und 'dashboard-actions'.
import Alpine from '../../vendor/alpinejs@3.17.5/dist/module.esm.js';
import { registerPlugin } from '../../core/plugin-registry.js';
import {
  SUPPLIERS, DELIVERY_STATUSES, supplierLabel, orderNumbersLabel, statusMeta, groupsByCourse, defaultWithoutInternalOrderNo,
} from '../../core/config.js';
import { pb } from '../../core/pb.js';
import {
  listOrderItems, getOrder, bookDelivery, uploadAttachments, backlogOf, errorMessage, listGroups,
  createOrderFromDeliveryNote, createUnmatchedReceipt,
} from '../../core/api.js';
import { toast, confirmAction } from '../../core/ui.js';
import { loadVision, fileToCanvas, detectCorners, defaultCorners, rectify, toGrayJpeg, toJpeg } from './vision.js';
import { preloadOcr, recognizePage, terminateOcr } from './ocr.js';
import { extractRows, matchRows, orderNumberTokens, rankOrders, findInternalOrderNumbers } from './matcher.js';
import { detectProfile, profileForOrder, profileMatchesOrder } from './profiles/index.js';
import { jpegsToPdf } from './pdf.js';
import { assessRecognition, buildAnalysis } from './report.js';

const MAX_RECEIPT_BYTES = 15 * 1024 * 1024; // = maxSize von deliveries.receipt
const MAX_REPORT_PHOTO_BYTES = 5 * 1024 * 1024; // = maxSize von scan_reports.photos
const CORNER_KEYS = ['topLeftCorner', 'topRightCorner', 'bottomRightCorner', 'bottomLeftCorner'];
const STATUS_COLORS = { sure: '#059669', check: '#d97706', none: '#dc2626' };

const template = /* html */ `
<div x-data="deliveryScanner" @open-delivery-scanner.window="open($event.detail)" x-cloak>
  <div x-show="isOpen" class="fixed inset-0 z-40 flex flex-col bg-white" @keydown.escape.window="isOpen && close()">
    <!-- Kopf -->
    <div class="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
      <div class="min-w-0 flex-1">
        <h2 class="text-base font-semibold">Lieferschein erfassen <span class="badge ml-1 bg-amber-50 text-amber-800 ring-amber-300 align-middle">Beta</span></h2>
        <p class="truncate text-xs text-slate-500" x-text="orderLabel()"></p>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" @click="close()">Schließen</button>
    </div>

    <div class="flex-1 overflow-y-auto">
      <div class="mx-auto max-w-3xl p-4">
        <p x-show="libState === 'loading'" class="mb-3 rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
          Bildverarbeitung wird geladen (einmalig ca. 25 MB, danach im Browser gespeichert) …
        </p>
        <p x-show="libState === 'error'" class="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700" x-text="libError"></p>

        <!-- Schritt: Seiten -->
        <section x-show="step === 'pages'">
          <p class="mb-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
            Testbetrieb: Erkannte Mengen bitte vor dem Buchen immer prüfen. Rückmeldungen zu schlecht erkannten Lieferscheinen helfen bei der Verbesserung.
          </p>
          <p class="mb-3 text-sm text-slate-600">
            Lieferschein flach auf einen <strong>dunklen, kontrastreichen Untergrund</strong> legen und von oben fotografieren.
            Mehrseitige Lieferscheine Seite für Seite aufnehmen.
          </p>
          <div class="mb-4 grid grid-cols-2 gap-2">
            <label class="btn btn-primary cursor-pointer py-3">
              Foto aufnehmen
              <input type="file" accept="image/*" capture="environment" class="hidden" @change="addFiles($event)">
            </label>
            <label class="btn btn-secondary cursor-pointer py-3">
              Bild auswählen
              <input type="file" accept="image/*" multiple class="hidden" @change="addFiles($event)">
            </label>
          </div>
          <p x-show="busyText" class="mb-3 text-sm text-blue-700" x-text="busyText"></p>
          <ol class="grid grid-cols-3 gap-2 sm:grid-cols-4" x-show="pages.length">
            <template x-for="(p, i) in pages" :key="p.id">
              <li class="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                <img :src="p.thumb" :alt="'Seite ' + (i + 1)" class="aspect-[1/1.414] w-full object-cover">
                <div class="flex items-center justify-between px-2 py-1 text-xs">
                  <span x-text="'Seite ' + (i + 1)"></span>
                  <button type="button" class="text-red-700" @click="removePage(i)" :aria-label="'Seite ' + (i + 1) + ' entfernen'">✕</button>
                </div>
              </li>
            </template>
          </ol>
          <div class="mt-4 flex justify-end">
            <button type="button" class="btn btn-success" :disabled="!pages.length || !!busyText" @click="recognize()">
              <span x-text="pages.length > 1 ? pages.length + ' Seiten erkennen' : 'Erkennung starten'"></span>
            </button>
          </div>
        </section>

        <!-- Schritt: Ecken prüfen -->
        <section x-show="step === 'corners'">
          <p class="mb-2 text-sm text-slate-600">
            <span x-show="cornersDetected">Blattkanten erkannt. Bei Bedarf die Eckpunkte verschieben.</span>
            <span x-show="!cornersDetected" class="text-amber-700">Blattkanten nicht sicher erkannt – bitte die vier Eckpunkte auf die Ecken des Lieferscheins ziehen.</span>
          </p>
          <!-- Bild in die verfügbare Höhe eingepasst (Seitenverhältnis bleibt), damit alle Ecken ohne Scrollen sichtbar sind -->
          <div class="relative mx-auto w-fit max-w-full">
            <canvas x-ref="cornerCanvas" class="block h-auto max-h-[calc(100dvh-13rem)] w-auto max-w-full touch-none rounded-lg border border-slate-200"
                    @pointerdown="cornerDown($event)" @pointermove="cornerMove($event)"
                    @pointerup="cornerUp($event)" @pointercancel="cornerUp($event)"></canvas>
            <!-- Lupe beim Ziehen: Ausschnitt um den Eckpunkt aus dem Originalfoto, oben auf der dem Punkt abgewandten Seite -->
            <canvas x-ref="loupe" x-show="loupeSide" data-loupe
                    class="pointer-events-none absolute top-2 size-[130px] rounded-full border-2 border-white shadow-lg ring-1 ring-slate-400"
                    :class="loupeSide === 'right' ? 'right-2' : 'left-2'"></canvas>
          </div>
          <!-- Knöpfe als feste Leiste am unteren Rand des Scrollbereichs -->
          <div class="sticky bottom-0 -mx-4 mt-3 flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-white/95 px-4 py-3" data-corner-actions>
            <button type="button" class="btn btn-ghost" @click="discardPhoto()">Verwerfen</button>
            <button type="button" class="btn btn-secondary" @click="useWholeImage()">Ganzes Bild</button>
            <button type="button" class="btn btn-primary" @click="acceptCorners()" :disabled="!!busyText">Übernehmen</button>
          </div>
        </section>

        <!-- Schritt: Erkennung läuft -->
        <section x-show="step === 'processing'" class="py-10 text-center">
          <p class="text-sm font-medium" x-text="progress.label"></p>
          <div class="mx-auto mt-3 h-2 max-w-xs overflow-hidden rounded-full bg-slate-100">
            <div class="h-full rounded-full bg-blue-600 transition-all" :style="'width:' + Math.round(progress.value * 100) + '%'"></div>
          </div>
          <p class="mt-2 text-xs text-slate-500">Auf dem Smartphone kann das pro Seite einige Sekunden dauern.</p>
        </section>

        <!-- Schritt: Prüfen & buchen -->
        <section x-show="step === 'review'" class="space-y-4">
          <template x-for="w in warnings" :key="w">
            <p class="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" x-text="w"></p>
          </template>

          <div x-show="recognitionFailed && !reported && !reportOpen" class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p class="font-medium">Die Erkennung hat bei diesem Lieferschein nicht geklappt.</p>
            <p class="mt-1 text-xs">Eine Meldung legt Fotos und Erkennungsergebnis zur Analyse auf dem Server ab – so lässt sich die Erkennung verbessern. Von Hand buchen geht trotzdem.</p>
            <button type="button" class="btn btn-secondary btn-sm mt-2" @click="openReport()">Problem melden</button>
          </div>

          <!-- Bestellung wählen (Start aus dem Dashboard) -->
          <div x-show="!lockedOrder" class="card p-3">
            <label class="label">Bestellung</label>
            <select class="input" x-model="selectedOrderId" @change="selectOrder(selectedOrderId)">
              <option value="">– bitte wählen –</option>
              <template x-for="c in orderCandidates" :key="c.id">
                <option :value="c.id" x-text="c.label"></option>
              </template>
            </select>
            <p class="hint" x-show="detectedOrderHint" x-text="detectedOrderHint"></p>
          </div>

          <!-- Keine passende Bestellung: daraus anlegen oder ablegen -->
          <div x-show="!lockedOrder && !order && !noOrder.mode" class="card space-y-2 border-violet-300 p-3" data-no-order>
            <h3 class="text-sm font-semibold">Keine passende Bestellung?</h3>
            <p class="text-xs text-slate-600">
              Z. B. Muster, Direktkauf oder eine Bestellung, die nicht im System erfasst wurde.
              <span x-show="!profileLabel">Für diesen Lieferanten gibt es kein Profil – der Lieferschein kann abgelegt und später einer Bestellung zugeordnet werden.</span>
            </p>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="btn btn-primary btn-sm" x-show="profileLabel" @click="startCreateOrder()">Bestellung aus Lieferschein anlegen</button>
              <button type="button" class="btn btn-secondary btn-sm" @click="startArchive()">In Ablage legen</button>
            </div>
          </div>

          <!-- Bestellung aus Lieferschein anlegen -->
          <div x-show="noOrder.mode === 'create'" class="card space-y-3 border-violet-300 p-3" data-create-order>
            <div class="flex items-center gap-2">
              <h3 class="mr-auto text-sm font-semibold">Bestellung aus Lieferschein anlegen</h3>
              <button type="button" class="btn btn-ghost btn-sm" @click="noOrder.mode = ''">Abbrechen</button>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div :class="create.supplier === 'other' ? '' : 'col-span-2'">
                <label class="label">Lieferant</label>
                <select class="input" x-model="create.supplier" aria-label="Lieferant">
                  <template x-for="s in suppliers" :key="s.value"><option :value="s.value" x-text="s.label"></option></template>
                </select>
              </div>
              <div x-show="create.supplier === 'other'">
                <label class="label">Shop-Name</label>
                <input class="input" x-model="create.supplier_custom_name" maxlength="100" aria-label="Shop-Name">
              </div>
              <div>
                <label class="label" for="create-internal-no">Interne Bestellnummer</label>
                <input id="create-internal-no" class="input font-mono" x-model="create.internal_order_no" maxlength="11"
                       :disabled="create.without_internal_order_no" placeholder="2026IW01047" spellcheck="false">
              </div>
              <div>
                <label class="label">Auftragsnr. des Shops <span class="font-normal text-slate-500">(optional)</span></label>
                <input class="input" x-model="create.supplier_order_no" maxlength="100" aria-label="Auftragsnummer des Shops">
              </div>
              <label class="col-span-2 flex items-center gap-2 text-sm">
                <input type="checkbox" x-model="create.without_internal_order_no" @change="create.without_internal_order_no && (create.internal_order_no = '')">
                ohne interne Bestellnummer (z. B. Muster, Direktkauf)
              </label>
            </div>
            <div>
              <h4 class="mb-1 text-xs font-semibold text-slate-600">Positionen (bestellt = geliefert)</h4>
              <ul class="space-y-2">
                <template x-for="(it, i) in create.items" :key="it.key">
                  <li class="grid grid-cols-[1.5rem_4.5rem_minmax(0,1fr)] items-center gap-2" :data-create-item="i">
                    <input type="checkbox" x-model="it.include" :aria-label="'Position ' + (i + 1) + ' übernehmen'">
                    <input class="input text-right" type="number" min="1" step="1" x-model.number="it.qty" aria-label="Menge">
                    <input class="input font-mono" x-model="it.part_number" maxlength="100" spellcheck="false" aria-label="Bestellnummer">
                    <span></span>
                    <input class="input col-span-2" x-model="it.name" maxlength="300" placeholder="Bezeichnung (empfohlen)" aria-label="Bezeichnung">
                    <span></span>
                    <select class="input col-span-2" x-model="it.group" aria-label="Gruppe">
                      <option value="">– ohne Gruppe –</option>
                      <template x-for="c in groupCourses" :key="c.label">
                        <optgroup :label="c.label">
                          <template x-for="g in c.groups" :key="g.id"><option :value="g.id" x-text="g.name"></option></template>
                        </optgroup>
                      </template>
                    </select>
                  </li>
                </template>
              </ul>
              <button type="button" class="btn btn-ghost btn-sm mt-2" @click="addCreateItem()">+ Position</button>
            </div>
            <div class="flex justify-end">
              <button type="button" class="btn btn-success" :disabled="busy" @click="submitCreateOrder()">
                <span x-text="busy ? 'Wird angelegt …' : 'Bestellung anlegen und Lieferung buchen'"></span>
              </button>
            </div>
          </div>

          <!-- In Ablage legen -->
          <div x-show="noOrder.mode === 'archive'" class="card space-y-3 border-violet-300 p-3" data-archive>
            <div class="flex items-center gap-2">
              <h3 class="mr-auto text-sm font-semibold">Lieferschein ablegen</h3>
              <button type="button" class="btn btn-ghost btn-sm" @click="noOrder.mode = ''">Abbrechen</button>
            </div>
            <p class="text-xs text-slate-600">Erscheint im Dashboard unter „Lieferscheine ohne Bestellung“ und kann später einer Bestellung zugeordnet werden.</p>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="label" for="archive-supplier">Lieferant</label>
                <input id="archive-supplier" class="input" x-model="archive.supplier_name" maxlength="100" required>
              </div>
              <div>
                <label class="label">Interne Bestellnr. <span class="font-normal text-slate-500">(falls bekannt)</span></label>
                <input class="input font-mono" x-model="archive.internal_order_no" maxlength="20" aria-label="Interne Bestellnummer">
              </div>
            </div>
            <div class="flex justify-end">
              <button type="button" class="btn btn-secondary" :disabled="busy" @click="submitArchive()">
                <span x-text="busy ? 'Wird abgelegt …' : 'In Ablage legen'"></span>
              </button>
            </div>
          </div>

          <template x-if="order">
            <div class="space-y-3">
              <div class="flex items-center gap-3 text-xs">
                <span class="flex items-center gap-1"><span class="inline-block h-2.5 w-2.5 rounded-full bg-emerald-600"></span> sicher</span>
                <span class="flex items-center gap-1"><span class="inline-block h-2.5 w-2.5 rounded-full bg-amber-600"></span> prüfen</span>
                <span class="flex items-center gap-1"><span class="inline-block h-2.5 w-2.5 rounded-full bg-slate-300"></span> nicht erkannt</span>
              </div>
              <ul class="space-y-2">
                <template x-for="r in reviewRows" :key="r.itemId">
                  <li class="card p-3" :class="{ 'border-emerald-300': r.status === 'sure', 'border-amber-400 bg-amber-50/40': r.status === 'check' }">
                    <div class="flex items-start gap-2">
                      <span class="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                            :class="{ 'bg-emerald-600': r.status === 'sure', 'bg-amber-600': r.status === 'check', 'bg-slate-300': r.status === 'missing' }"></span>
                      <div class="min-w-0 flex-1">
                        <div class="font-mono text-sm font-semibold break-all" x-text="r.part"></div>
                        <div x-show="r.name" class="truncate text-xs text-slate-600" x-text="r.name"></div>
                        <div x-show="r.note" class="mt-1 rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-900" x-text="r.note"></div>
                        <div x-show="r.reasons.length" class="mt-1 text-xs text-amber-800" x-text="r.reasons.join(' · ')"></div>
                      </div>
                      <div class="w-20 shrink-0">
                        <label class="label text-center">Neu</label>
                        <input class="input text-right" type="number" step="1" inputmode="numeric" x-model.number="r.qty"
                               :aria-label="'Neu geliefert ' + r.part">
                      </div>
                    </div>
                    <dl class="mt-2 grid grid-cols-3 gap-1 text-center text-xs">
                      <div class="rounded bg-slate-50 p-1"><dt class="text-slate-500">Bestellt</dt><dd class="font-semibold" x-text="r.ordered"></dd></div>
                      <div class="rounded bg-slate-50 p-1"><dt class="text-slate-500">Bisher</dt><dd class="font-semibold" x-text="r.delivered"></dd></div>
                      <div class="rounded p-1" :class="r.backlog - (r.qty || 0) > 0 ? 'bg-amber-100' : 'bg-emerald-50'">
                        <dt class="text-slate-500">Rückstand danach</dt><dd class="font-semibold" x-text="Math.max(0, r.backlog - (r.qty || 0))"></dd>
                      </div>
                    </dl>
                  </li>
                </template>
              </ul>

              <!-- Nicht zugeordnete Zeilen -->
              <div x-show="unmatched.length" class="card p-3">
                <h3 class="mb-2 text-sm font-semibold">Nicht zugeordnete Zeilen</h3>
                <ul class="space-y-2">
                  <template x-for="u in unmatched" :key="u.key">
                    <li class="text-sm" :data-unmatched="u.key">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="font-mono" x-text="u.qty + ' × ' + u.part"></span>
                        <select class="input ml-auto w-auto" x-model="u.assignTo" :disabled="u.assigned" @change="assignUnmatched(u)"
                                :aria-label="'Zeile ' + u.part + ' zuordnen'">
                          <option value="">– zuordnen –</option>
                          <option value="__new">als neue Position nachtragen</option>
                          <template x-for="r in reviewRows" :key="r.itemId">
                            <option :value="r.itemId" x-text="r.part"></option>
                          </template>
                        </select>
                      </div>
                      <div x-show="u.addNew" class="mt-2 grid grid-cols-[5rem_minmax(0,1fr)] gap-2 rounded-lg bg-violet-50 p-2">
                        <p class="col-span-2 text-xs text-violet-900">Wird als vergessene Position nachgetragen (gekennzeichnet) und mit dieser Lieferung gebucht. Bestellnummer bitte prüfen.</p>
                        <input class="input text-right" type="number" min="1" step="1" x-model.number="u.qty" aria-label="Menge der nachgetragenen Position">
                        <input class="input font-mono" x-model="u.part" maxlength="100" spellcheck="false" aria-label="Bestellnummer der nachgetragenen Position">
                        <input class="input col-span-2" x-model="u.name" maxlength="300" placeholder="Bezeichnung (empfohlen)" aria-label="Bezeichnung der nachgetragenen Position">
                        <select class="input col-span-2" x-model="u.group" aria-label="Gruppe der nachgetragenen Position">
                          <option value="">– ohne Gruppe –</option>
                          <template x-for="c in groupCourses" :key="c.label">
                            <optgroup :label="c.label">
                              <template x-for="g in c.groups" :key="g.id"><option :value="g.id" x-text="g.name"></option></template>
                            </optgroup>
                          </template>
                        </select>
                      </div>
                    </li>
                  </template>
                </ul>
              </div>
            </div>
          </template>

          <!-- Belegbild mit Markierungen -->
          <details class="card p-3">
            <summary class="cursor-pointer text-sm font-medium">Erkannte Bereiche im Beleg anzeigen</summary>
            <div class="mt-3 space-y-3">
              <template x-for="(p, i) in pages" :key="p.id">
                <canvas class="w-full rounded border border-slate-200" :data-review-page="i"></canvas>
              </template>
            </div>
          </details>

          <div>
            <label class="label">Notiz (optional)</label>
            <input class="input" x-model="note" maxlength="500" placeholder="z. B. Paket 1 von 2">
          </div>

          <div x-show="reportOpen" class="card space-y-2 border-amber-300 p-3" data-scan-report>
            <h3 class="text-sm font-semibold">Problem melden</h3>
            <p class="text-xs text-slate-600">
              Originalfotos, erkannter Text und die eingetragenen Mengen werden auf dem Server abgelegt, der Administrator bekommt eine Mail.
              Am meisten hilft es, vorher die richtigen Mengen einzutragen.
            </p>
            <ul x-show="problems.length" class="list-disc pl-5 text-xs text-amber-800">
              <template x-for="p in problems" :key="p"><li x-text="p"></li></template>
            </ul>
            <textarea class="input" rows="2" maxlength="1000" x-model="reportNote" placeholder="Was ist schiefgelaufen? (optional)" aria-label="Beschreibung des Problems"></textarea>
            <div class="flex justify-end gap-2">
              <button type="button" class="btn btn-ghost" @click="reportOpen = false" :disabled="reportBusy">Abbrechen</button>
              <button type="button" class="btn btn-primary" @click="sendReport()" :disabled="reportBusy">
                <span x-text="reportBusy ? 'Wird gesendet …' : 'Meldung senden'"></span>
              </button>
            </div>
          </div>
          <p x-show="reported" class="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800">Problem gemeldet – danke! Die Lieferung kann trotzdem gebucht werden.</p>

          <div class="flex flex-wrap justify-end gap-2 pb-6">
            <button type="button" class="btn btn-ghost mr-auto" x-show="!reported && !reportOpen" @click="openReport()">Problem melden</button>
            <button type="button" class="btn btn-secondary" @click="step = 'pages'">Seiten bearbeiten</button>
            <button type="button" class="btn btn-success" :disabled="!order || busy" @click="book()">
              <span x-text="busy ? 'Wird gebucht …' : (hasQuantities() ? 'Lieferung buchen' : 'Nur Beleg an Bestellung anhängen')"></span>
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</div>`;

function component() {
  // Nicht-reaktive Arbeitsdaten (Canvas/Blobs gehören nicht in Alpine-Proxies).
  let queue = [];
  let source = null; // { canvas, corners, display: { scale }, drag }
  let pageData = []; // [{ canvas, jpeg, ocr }]
  let assignments = [];
  let extracted = { rows: [], missingHeader: [] };
  let detectedProfile = null;
  let internalNos = []; // auf dem Lieferschein gelesene interne Bestellnummern
  let pageCounter = 0;

  return {
    isOpen: false,
    step: 'pages',
    libState: 'idle',
    libError: '',
    busyText: '',
    pages: [], // [{ id, thumb }]
    cornersDetected: true,
    loupeSide: '', // '' = Lupe ausgeblendet, sonst 'left'/'right'
    progress: { value: 0, label: '' },
    order: null,
    items: [],
    lockedOrder: false,
    orderCandidates: [],
    selectedOrderId: '',
    detectedOrderHint: '',
    warnings: [],
    reviewRows: [],
    unmatched: [],
    groupCourses: [],
    suppliers: SUPPLIERS,
    profileLabel: '',
    noOrder: { mode: '' },
    create: { items: [] },
    archive: {},
    note: '',
    busy: false,
    problems: [],
    recognitionFailed: false,
    reportOpen: false,
    reportNote: '',
    reportBusy: false,
    reported: false,

    // ---- Öffnen / Schließen -------------------------------------------------
    async open(detail = {}) {
      this.reset();
      this.isOpen = true;
      if (detail.order) {
        this.order = detail.order;
        this.items = detail.items ?? [];
        this.lockedOrder = true;
      }
      this.libState = 'loading';
      try {
        await loadVision();
        preloadOcr().catch(() => {}); // im Hintergrund, Fehler zeigt sich bei der Erkennung
        this.libState = 'ready';
      } catch (err) {
        this.libState = 'error';
        this.libError = 'Bildverarbeitung konnte nicht geladen werden: ' + (err?.message ?? err);
      }
    },

    async close() {
      if (this.pages.length && !(await confirmAction('Erfassung abbrechen? Aufgenommene Seiten gehen verloren.',
        { confirmLabel: 'Verwerfen', cancelLabel: 'Weiter erfassen', danger: true }))) return;
      this.isOpen = false;
      this.reset();
      await terminateOcr();
    },

    reset() {
      this.pages.forEach((p) => URL.revokeObjectURL(p.thumb));
      queue = [];
      source = null;
      pageData = [];
      assignments = [];
      extracted = { rows: [], missingHeader: [] };
      detectedProfile = null;
      internalNos = [];
      Object.assign(this, {
        step: 'pages', busyText: '', pages: [], cornersDetected: true, loupeSide: '', progress: { value: 0, label: '' },
        order: null, items: [], lockedOrder: false, orderCandidates: [], selectedOrderId: '', detectedOrderHint: '',
        warnings: [], reviewRows: [], unmatched: [], note: '', busy: false,
        profileLabel: '', noOrder: { mode: '' }, create: { items: [] }, archive: {},
        problems: [], recognitionFailed: false, reportOpen: false, reportNote: '', reportBusy: false, reported: false,
      });
    },

    orderLabel() {
      if (!this.order) return 'Bestellung wird nach der Erkennung zugeordnet';
      return supplierLabel(this.order) + ' · ' + orderNumbersLabel(this.order);
    },

    // ---- Seiten aufnehmen ---------------------------------------------------
    async addFiles(event) {
      const files = [...event.target.files];
      event.target.value = '';
      if (!files.length) return;
      queue.push(...files);
      if (this.step !== 'corners') await this.nextFromQueue();
    },

    async nextFromQueue() {
      const file = queue.shift();
      if (!file) {
        this.step = 'pages';
        return;
      }
      this.busyText = 'Bild wird vorbereitet …';
      try {
        await loadVision();
        const canvas = await fileToCanvas(file);
        const { corners, detected } = detectCorners(canvas);
        source = { canvas, corners, cornersAuto: detected ? structuredClone(corners) : null, detected, drag: null, display: null };
        this.cornersDetected = detected;
        this.step = 'corners';
        await this.$nextTick();
        this.drawCorners();
      } catch (err) {
        toast.error('Bild konnte nicht verarbeitet werden: ' + (err?.message ?? err));
        this.step = 'pages';
      } finally {
        this.busyText = '';
      }
    },

    drawCorners() {
      const view = this.$refs.cornerCanvas;
      if (!view || !source) return;
      const maxSide = 1100;
      const scale = Math.min(1, maxSide / Math.max(source.canvas.width, source.canvas.height));
      view.width = Math.round(source.canvas.width * scale);
      view.height = Math.round(source.canvas.height * scale);
      source.display = { scale };
      const ctx = view.getContext('2d');
      ctx.drawImage(source.canvas, 0, 0, view.width, view.height);
      const pts = CORNER_KEYS.map((k) => source.corners[k]).map((p) => ({ x: p.x * scale, y: p.y * scale }));
      ctx.fillStyle = 'rgba(37, 99, 235, 0.12)';
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = Math.max(2, view.width / 300);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      const r = Math.max(10, view.width / 40);
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fill();
        ctx.stroke();
      }
    },

    /** Zeiger-Position in Bildkoordinaten des Quellbildes. */
    pointerToImage(event) {
      const view = this.$refs.cornerCanvas;
      const rect = view.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * view.width;
      const y = ((event.clientY - rect.top) / rect.height) * view.height;
      return { x: x / source.display.scale, y: y / source.display.scale, cssPerImage: rect.width / view.width * source.display.scale };
    },

    /** Bildschirmposition (CSS-Pixel im Viewport) eines Eckpunkts – für Bedienhilfen und den Browser-Test. */
    cornerScreenPoint(key) {
      const view = this.$refs.cornerCanvas;
      if (!view || !source?.display) return null;
      const r = view.getBoundingClientRect();
      const c = source.corners[key];
      return { x: r.left + c.x * source.display.scale * r.width / view.width, y: r.top + c.y * source.display.scale * r.height / view.height };
    },

    cornerDown(event) {
      if (!source?.display) return;
      const p = this.pointerToImage(event);
      const threshold = 48 / p.cssPerImage; // ca. 48 CSS-Pixel Fangradius (Finger)
      let best = null;
      for (const k of CORNER_KEYS) {
        const c = source.corners[k];
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d < threshold && (!best || d < best.d)) best = { k, d };
      }
      if (best) {
        source.drag = best.k;
        event.target.setPointerCapture(event.pointerId);
        this.drawLoupe();
      }
    },

    cornerMove(event) {
      if (!source?.drag) return;
      const p = this.pointerToImage(event);
      source.corners[source.drag] = {
        x: Math.min(source.canvas.width, Math.max(0, p.x)),
        y: Math.min(source.canvas.height, Math.max(0, p.y)),
      };
      this.drawCorners();
      this.drawLoupe();
    },

    cornerUp(event) {
      if (source?.drag) event.target.releasePointerCapture?.(event.pointerId);
      if (source) source.drag = null;
      this.loupeSide = '';
    },

    /**
     * Lupe für den gezogenen Eckpunkt: dreifach vergrößerter Ausschnitt (bezogen auf die Anzeige) aus dem Originalfoto,
     * mit Blattkanten und Fadenkreuz. Steht oben auf der dem Punkt abgewandten Seite, damit der Finger sie nicht verdeckt.
     */
    drawLoupe() {
      const view = this.$refs.cornerCanvas;
      const loupe = this.$refs.loupe;
      if (!source?.drag || !view || !loupe) return;
      const LOUPE_CSS = 130;
      const ZOOM = 3;
      const p = source.corners[source.drag];
      this.loupeSide = p.x < source.canvas.width / 2 ? 'right' : 'left';

      const dpr = window.devicePixelRatio || 1;
      const size = Math.round(LOUPE_CSS * dpr);
      if (loupe.width !== size) { loupe.width = size; loupe.height = size; }
      const cssPerImage = view.getBoundingClientRect().width / view.width * source.display.scale;
      const k = (cssPerImage * ZOOM * dpr); // Lupenpixel je Bildpixel
      const ctx = loupe.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#334155';
      ctx.fillRect(0, 0, size, size);

      // Ausschnitt auf das Bild begrenzen (Rand außerhalb bleibt grau)
      const half = size / 2 / k;
      const sx = Math.max(0, p.x - half), sy = Math.max(0, p.y - half);
      const ex = Math.min(source.canvas.width, p.x + half), ey = Math.min(source.canvas.height, p.y + half);
      if (ex > sx && ey > sy) {
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source.canvas, sx, sy, ex - sx, ey - sy,
          (sx - p.x) * k + size / 2, (sy - p.y) * k + size / 2, (ex - sx) * k, (ey - sy) * k);
      }

      // Blattkanten der aktuellen Auswahl
      const toLoupe = (c) => ({ x: (c.x - p.x) * k + size / 2, y: (c.y - p.y) * k + size / 2 });
      const pts = CORNER_KEYS.map((key) => toLoupe(source.corners[key]));
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.stroke();

      // Fadenkreuz am Eckpunkt (weiß unterlegt, auf hellem und dunklem Grund sichtbar)
      const c = size / 2, arm = 14 * dpr, gap = 4 * dpr;
      for (const [color, width] of [['rgba(255,255,255,0.9)', 4 * dpr], ['#dc2626', 1.5 * dpr]]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(c - arm, c); ctx.lineTo(c - gap, c);
        ctx.moveTo(c + gap, c); ctx.lineTo(c + arm, c);
        ctx.moveTo(c, c - arm); ctx.lineTo(c, c - gap);
        ctx.moveTo(c, c + gap); ctx.lineTo(c, c + arm);
        ctx.stroke();
      }
    },

    useWholeImage() {
      source.corners = defaultCorners(source.canvas.width, source.canvas.height, 0);
      this.acceptCorners();
    },

    discardPhoto() {
      source = null;
      this.nextFromQueue();
    },

    async acceptCorners() {
      this.busyText = 'Seite wird entzerrt …';
      try {
        const canvas = rectify(source.canvas, source.corners);
        const [jpeg, original] = await Promise.all([toGrayJpeg(canvas), toJpeg(source.canvas)]);
        pageData.push({
          canvas, jpeg, ocr: null,
          // für Problem-Meldungen: Originalfoto und Eckpunkte (Koordinaten im Originalfoto)
          original,
          meta: {
            source: { width: source.canvas.width, height: source.canvas.height },
            cornersDetected: source.detected,
            cornersAuto: source.cornersAuto,
            corners: structuredClone(source.corners),
            rectified: { width: canvas.width, height: canvas.height },
          },
        });
        this.pages.push({ id: ++pageCounter, thumb: URL.createObjectURL(jpeg) });
        source = null;
      } catch (err) {
        toast.error('Entzerrung fehlgeschlagen: ' + (err?.message ?? err));
      } finally {
        this.busyText = '';
      }
      await this.nextFromQueue();
    },

    removePage(i) {
      URL.revokeObjectURL(this.pages[i].thumb);
      this.pages.splice(i, 1);
      pageData.splice(i, 1);
    },

    // ---- Erkennung -----------------------------------------------------------
    async recognize() {
      this.step = 'processing';
      Object.assign(this, { reportOpen: false, reported: false, reportNote: '' });
      try {
        for (let i = 0; i < pageData.length; i++) {
          const label = pageData.length > 1 ? `Seite ${i + 1} von ${pageData.length}: ` : '';
          this.progress = { value: 0, label: label + 'Texterkennung wird vorbereitet …' };
          pageData[i].ocr ??= await recognizePage(pageData[i].canvas, (value, status) => {
            this.progress = {
              value: (i + value) / pageData.length,
              label: label + (status === 'recognizing text' ? 'Text wird erkannt …' : 'Texterkennung wird geladen …'),
            };
          });
        }
        await this.analyze();
        this.step = 'review';
        await this.$nextTick();
        this.drawReviewPages();
      } catch (err) {
        toast.error('Texterkennung fehlgeschlagen: ' + (err?.message ?? err));
        this.step = 'pages';
      }
    },

    async analyze() {
      const ocrPages = pageData.map((p) => p.ocr);
      const detected = detectProfile(ocrPages);
      detectedProfile = detected;
      this.profileLabel = detected?.label ?? '';
      this.noOrder = { mode: '' };
      internalNos = findInternalOrderNumbers(ocrPages);
      this.warnings = [];

      if (!this.lockedOrder) {
        await this.loadOrderCandidates(detected, ocrPages);
      } else {
        if (detected && !profileMatchesOrder(detected, this.order)) {
          this.warnings.push(`Der Lieferschein sieht nach ${detected.label} aus, die Bestellung ist aber bei ${supplierLabel(this.order)}. Bitte prüfen.`);
        }
        const own = this.order.internal_order_no;
        if (own && internalNos.length && !internalNos.includes(own)) {
          this.warnings.push(`Auf dem Lieferschein steht die Bestellnummer ${internalNos.join(', ')}, diese Bestellung hat ${own}. Bitte prüfen.`);
        }
      }
      this.computeReview();
      this.updateAssessment();
    },

    async loadOrderCandidates(detected, ocrPages) {
      const statusFilter = DELIVERY_STATUSES.filter((s) => s !== 'geliefert').map((s) => `status = "${s}"`).join(' || ');
      const filter = detected ? `(${statusFilter}) && supplier = "${detected.supplier}"` : statusFilter;
      const [openOrders, byNumber] = await Promise.all([
        pb.collection('orders').getFullList({ filter, sort: '-updated' }),
        internalNos.length
          ? pb.collection('orders').getFullList({ filter: internalNos.map((no) => pb.filter('internal_order_no = {:no}', { no })).join(' || ') })
          : [],
      ]);
      // bei „sonstigen“ Lieferanten zusätzlich über den Shop-Namen eingrenzen
      const orders = detected ? openOrders.filter((o) => profileMatchesOrder(detected, o)) : openOrders;
      const ranked = rankOrders(orders, orderNumberTokens(ocrPages[0]));
      const candidates = [...byNumber.filter((o) => DELIVERY_STATUSES.includes(o.status)), ...ranked.map((r) => r.order).filter((o) => !byNumber.some((b) => b.id === o.id))];
      this.orderCandidates = candidates.map((order) => ({
        id: order.id,
        label: supplierLabel(order) + ' · ' + orderNumbersLabel(order),
      }));
      this.detectedOrderHint = detected ? `Erkannter Lieferant: ${detected.label}.` : 'Lieferant nicht erkannt.';

      // 1. Wahl: eindeutig gelesene interne Bestellnummer (lieferantenunabhängig)
      if (byNumber.length === 1) {
        const order = byNumber[0];
        if (!DELIVERY_STATUSES.includes(order.status)) {
          this.warnings.push(`Die Bestellung ${order.internal_order_no} hat den Status „${statusMeta(order.status).label}“ – hier kann keine Lieferung gebucht werden.`);
          return;
        }
        if (detected && !profileMatchesOrder(detected, order)) {
          this.warnings.push(`Der Lieferschein sieht nach ${detected.label} aus, die Bestellung ${order.internal_order_no} ist aber bei ${supplierLabel(order)}. Bitte prüfen.`);
        }
        this.detectedOrderHint += ` Bestellung über die interne Bestellnummer ${order.internal_order_no} zugeordnet.`;
        await this.selectOrder(order.id);
        return;
      }
      if (byNumber.length > 1) {
        this.warnings.push(`Auf dem Lieferschein stehen mehrere Bestellnummern (${internalNos.join(', ')}). Bitte die Bestellung wählen.`);
        return;
      }
      if (internalNos.length) {
        this.warnings.push(`Die Bestellnummer ${internalNos.join(', ')} ist keiner Bestellung im System zugeordnet.`);
      }

      // 2. Wahl: unscharfer Vergleich der Nummern bzw. einzige offene Bestellung
      const top = ranked[0];
      const clear = top && (top.sim >= 0.8 || ranked.length === 1) && (ranked.length === 1 || top.sim - ranked[1].sim >= 0.1);
      if (clear) {
        this.detectedOrderHint += top.sim >= 0.8 ? ' Bestellung über eine ähnliche Nummer zugeordnet – bitte prüfen.' : ' Einzige offene Bestellung vorausgewählt – bitte prüfen.';
        await this.selectOrder(top.order.id);
      } else if (!ranked.length) {
        this.warnings.push(detected ? 'Keine offene Bestellung für diesen Lieferanten gefunden.' : 'Keine offene Bestellung gefunden.');
      }
    },

    async selectOrder(id) {
      this.selectedOrderId = id;
      if (!id) {
        this.order = null;
        this.items = [];
        this.reviewRows = [];
        this.unmatched = [];
        assignments = [];
        extracted = { rows: [], missingHeader: [] };
        this.updateAssessment();
        return;
      }
      try {
        [this.order, this.items] = await Promise.all([getOrder(id), listOrderItems(id)]);
        this.computeReview();
        this.updateAssessment();
        await this.$nextTick();
        this.drawReviewPages();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    computeReview() {
      if (!this.order) return;
      const profile = profileForOrder(this.order);
      const rows = [];
      const missingHeader = [];
      if (profile) {
        pageData.forEach((p, page) => {
          const res = extractRows(p.ocr, profile);
          if (res.headerFound === false) missingHeader.push(page + 1);
          res.rows.forEach((r) => rows.push({ ...r, page }));
        });
      }
      this.warnings = this.warnings.filter((w) => !w.startsWith('Für ') && !w.startsWith('Auf Seite'));
      if (!profile) {
        this.warnings.push(`Für ${supplierLabel(this.order)} gibt es noch kein Lieferschein-Profil. Bitte die Mengen von Hand eintragen.`);
      } else if (missingHeader.length) {
        this.warnings.push(`Auf Seite ${missingHeader.join(', ')} wurde die Positionstabelle nicht gefunden. Bitte Foto prüfen oder Mengen von Hand eintragen.`);
      }

      extracted = { rows, missingHeader };
      const result = matchRows(rows, this.items);
      assignments = result.assignments;
      this.reviewRows = this.items.map((it) => {
        const m = result.perItem[it.id];
        return {
          itemId: it.id,
          part: it.part_number,
          name: it.name,
          note: it.group_allocation_note,
          ordered: it.qty_ordered,
          delivered: it.qty_delivered,
          backlog: backlogOf(it),
          qty: m?.qty ?? 0,
          recognized: m?.qty ?? 0,
          status: m ? m.status : 'missing',
          reasons: m?.reasons ?? [],
        };
      });
      this.unmatched = assignments
        .filter((a) => a.status === 'none')
        .map((a, i) => ({ key: i, part: a.row.part, qty: a.row.qty, assignTo: '', assigned: false, addNew: false, name: '', group: '' }));
    },

    updateAssessment() {
      const { failed, problems } = assessRecognition({
        pages: pageData.map((p) => p.meta),
        detectedProfile,
        order: this.order,
        orderProfile: this.order ? profileForOrder(this.order) : null,
        missingHeader: extracted.missingHeader,
        rows: extracted.rows,
        assignments,
      });
      this.recognitionFailed = failed;
      this.problems = problems;
    },

    async assignUnmatched(u) {
      u.addNew = u.assignTo === '__new';
      if (u.addNew) {
        if (!this.groupCourses.length) {
          try {
            this.groupCourses = groupsByCourse(await listGroups({ onlyActive: true }));
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }
        return;
      }
      const row = this.reviewRows.find((r) => r.itemId === u.assignTo);
      if (!row) return;
      row.qty = (row.qty || 0) + u.qty;
      row.status = 'check';
      row.reasons = [...row.reasons, 'von Hand zugeordnet'];
      u.assigned = true;
    },

    drawReviewPages() {
      const canvases = this.$root.querySelectorAll('canvas[data-review-page]');
      canvases.forEach((view) => {
        const i = Number(view.dataset.reviewPage);
        const src = pageData[i]?.canvas;
        if (!src) return;
        const scale = Math.min(1, 1000 / src.width);
        view.width = Math.round(src.width * scale);
        view.height = Math.round(src.height * scale);
        const ctx = view.getContext('2d');
        ctx.drawImage(src, 0, 0, view.width, view.height);
        ctx.lineWidth = 2;
        for (const a of assignments.filter((x) => x.row.page === i)) {
          const b = a.row.box;
          ctx.strokeStyle = STATUS_COLORS[a.status];
          ctx.strokeRect(b.x0 * view.width - 3, b.y0 * view.height - 3, (b.x1 - b.x0) * view.width + 6, (b.y1 - b.y0) * view.height + 6);
        }
      });
    },

    // ---- Problem melden ------------------------------------------------------
    openReport() {
      this.reportOpen = true;
      this.$nextTick(() => this.$root.querySelector('[data-scan-report]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    },

    async sendReport() {
      const tooBig = pageData.findIndex((p) => p.original.size > MAX_REPORT_PHOTO_BYTES);
      if (tooBig >= 0) {
        toast.error(`Foto von Seite ${tooBig + 1} ist für die Meldung zu groß (max. 5 MB).`);
        return;
      }
      const analysis = buildAnalysis({
        pages: pageData.map((p) => ({ ...p.meta, ocr: p.ocr })),
        detectedProfile,
        order: this.order,
        items: this.items,
        rows: extracted.rows,
        assignments,
        review: this.reviewRows,
        assessment: { failed: this.recognitionFailed, problems: this.problems },
        warnings: this.warnings,
        internalOrderNos: internalNos,
        client: { userAgent: navigator.userAgent, viewport: { width: window.innerWidth, height: window.innerHeight } },
      });
      const form = new FormData();
      form.append('reported_by', pb.authStore.record?.id ?? '');
      if (this.order) form.append('order', this.order.id);
      form.append('note', this.reportNote.trim());
      form.append('analysis', JSON.stringify(analysis));
      pageData.forEach((p, i) => form.append('photos', p.original, `seite-${i + 1}.jpg`));

      this.reportBusy = true;
      try {
        await pb.collection('scan_reports').create(form);
        this.reported = true;
        this.reportOpen = false;
        toast.success('Problem gemeldet – danke!');
      } catch (err) {
        toast.error('Meldung fehlgeschlagen: ' + errorMessage(err));
      } finally {
        this.reportBusy = false;
      }
    },

    // ---- Buchen ------------------------------------------------------------
    hasQuantities() {
      return this.reviewRows.some((r) => Number(r.qty) !== 0) || this.unmatched.some((u) => u.addNew);
    },

    async buildPdf(label = this.order?.supplier ?? 'unbekannt') {
      const pdf = await jpegsToPdf(pageData.map((p) => p.jpeg));
      if (pdf.length > MAX_RECEIPT_BYTES) {
        throw new Error(`Der Beleg ist mit ${(pdf.length / 1048576).toFixed(1)} MB zu groß (max. 15 MB).`);
      }
      const date = new Date().toISOString().slice(0, 10);
      const safe = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lieferschein';
      return new File([pdf], `lieferschein-${safe}-${date}.pdf`, { type: 'application/pdf' });
    },

    // ---- Keine passende Bestellung ---------------------------------------------
    async loadGroupCourses() {
      if (this.groupCourses.length) return;
      try {
        this.groupCourses = groupsByCourse(await listGroups({ onlyActive: true }));
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },

    async startCreateOrder() {
      const p = detectedProfile;
      const rows = this.rowsForProfile(p); // unabhängig von einer zuvor gewählten Bestellung
      let key = 0;
      this.create = {
        supplier: p?.supplier ?? 'other',
        supplier_custom_name: p?.supplier === 'other' ? p.label : '',
        internal_order_no: internalNos[0] ?? '',
        without_internal_order_no: defaultWithoutInternalOrderNo({ supplier: p?.supplier, internal_order_no: internalNos[0] }),
        supplier_order_no: '',
        items: rows.map((r) => ({ key: ++key, include: true, qty: r.qty, part_number: r.part, name: '', group: '' })),
      };
      if (!this.create.items.length) this.addCreateItem();
      this.noOrder = { mode: 'create' };
      await this.loadGroupCourses();
    },

    /** Zeilen ohne gewählte Bestellung mit dem erkannten Profil lesen. */
    rowsForProfile(profile) {
      if (!profile) return [];
      return pageData.flatMap((p, page) => extractRows(p.ocr, profile).rows.map((r) => ({ ...r, page })));
    },

    addCreateItem() {
      const key = Math.max(0, ...this.create.items.map((i) => i.key)) + 1;
      this.create.items.push({ key, include: true, qty: 1, part_number: '', name: '', group: '' });
    },

    async submitCreateOrder() {
      const c = this.create;
      const items = c.items.filter((i) => i.include)
        .map((i) => ({ part_number: i.part_number.trim(), name: i.name.trim(), qty: Number(i.qty), group: i.group }));
      if (!items.length) { toast.error('Mindestens eine Position übernehmen.'); return; }
      if (items.some((i) => !i.part_number || !Number.isInteger(i.qty) || i.qty < 1)) {
        toast.error('Jede Position braucht Bestellnummer und Menge (ganze Zahl ≥ 1).');
        return;
      }
      if (!c.without_internal_order_no && !c.internal_order_no.trim()) {
        toast.error('Bitte die interne Bestellnummer eintragen oder „ohne interne Bestellnummer“ wählen.');
        return;
      }
      if (!(await confirmAction(`Neue Bestellung mit ${items.length} Position(en) anlegen und als geliefert buchen?`,
        { confirmLabel: 'Anlegen und buchen' }))) return;
      this.busy = true;
      try {
        const receipt = await this.buildPdf(c.supplier === 'other' ? c.supplier_custom_name : c.supplier);
        const r = await createOrderFromDeliveryNote({
          supplier: c.supplier,
          supplier_custom_name: c.supplier === 'other' ? c.supplier_custom_name : '',
          internal_order_no: c.without_internal_order_no ? '' : c.internal_order_no.trim(),
          without_internal_order_no: c.without_internal_order_no ? 'true' : '',
          supplier_order_no: c.supplier_order_no.trim(),
          note: this.note,
          items,
        }, receipt);
        toast.success(`Bestellung ${supplierLabel(r.order)} · ${orderNumbersLabel(r.order)} angelegt, Lieferung gebucht.`);
        this.isOpen = false;
        this.reset();
        await terminateOcr();
        location.hash = '#/orders/' + r.order.id;
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    startArchive() {
      this.archive = { supplier_name: this.profileLabel, internal_order_no: internalNos[0] ?? '' };
      this.noOrder = { mode: 'archive' };
    },

    async submitArchive() {
      const a = this.archive;
      if (!a.supplier_name?.trim()) { toast.error('Bitte den Lieferanten angeben.'); return; }
      this.busy = true;
      try {
        const receipt = await this.buildPdf(a.supplier_name);
        await createUnmatchedReceipt({ supplier_name: a.supplier_name.trim(), internal_order_no: a.internal_order_no.trim(), note: this.note }, receipt);
        toast.success('Lieferschein abgelegt – im Dashboard unter „Lieferscheine ohne Bestellung“.');
        this.isOpen = false;
        this.reset();
        await terminateOcr();
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    async book() {
      const invalid = this.reviewRows.find((r) => !Number.isInteger(Number(r.qty)));
      if (invalid) {
        toast.error(`Ungültige Menge bei ${invalid.part}.`);
        return;
      }
      const lines = this.reviewRows.filter((r) => Number(r.qty) !== 0).map((r) => ({ item: r.itemId, qty: Number(r.qty) }));
      const newItems = this.unmatched.filter((u) => u.addNew)
        .map((u) => ({ part_number: u.part.trim(), name: u.name.trim(), qty: Number(u.qty), group: u.group }));
      const badNew = newItems.find((n) => !n.part_number || !Number.isInteger(n.qty) || n.qty < 1);
      if (badNew) {
        toast.error('Nachzutragende Position: Bestellnummer und Menge (ganze Zahl ≥ 1) angeben.');
        return;
      }
      const unchecked = this.reviewRows.filter((r) => r.status === 'check' && Number(r.qty) !== 0).length;
      if (unchecked && !(await confirmAction(`${unchecked} Position(en) sind zur Prüfung markiert. Trotzdem buchen?`,
        { confirmLabel: 'Trotzdem buchen' }))) return;

      this.busy = true;
      try {
        const receipt = await this.buildPdf();
        if (lines.length || newItems.length) {
          await bookDelivery(this.order.id, lines, { note: this.note, receipt, newItems });
          toast.success(`Lieferung mit ${lines.length + newItems.length} Position(en) gebucht` +
            (newItems.length ? `, davon ${newItems.length} nachgetragen` : '') + ', Beleg angehängt.');
        } else {
          await uploadAttachments(this.order.id, [receipt]);
          toast.success('Beleg an die Bestellung angehängt.');
        }
        this.isOpen = false;
        this.reset();
        await terminateOcr();
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },
  };
}

// ---- Einhängen ----------------------------------------------------------------
Alpine.data('deliveryScanner', component);
const host = document.createElement('div');
host.innerHTML = template;
document.body.appendChild(host.firstElementChild);

const openScanner = (detail) => window.dispatchEvent(new CustomEvent('open-delivery-scanner', { detail }));

registerPlugin({
  id: 'delivery-scanner-order',
  slot: 'order-detail-actions',
  label: 'Lieferschein scannen (Beta)',
  icon: 'scan',
  isVisible: (order) => DELIVERY_STATUSES.includes(order?.status),
  // Kopien übergeben: die Werte der Detailansicht sind reaktive Proxies einer anderen Komponente.
  onClick: (order, items) => openScanner({ order: JSON.parse(JSON.stringify(order)), items: JSON.parse(JSON.stringify(items)) }),
});

registerPlugin({
  id: 'delivery-scanner-dashboard',
  slot: 'dashboard-actions',
  label: 'Lieferschein scannen (Beta)',
  icon: 'scan',
  onClick: () => openScanner({}),
});
