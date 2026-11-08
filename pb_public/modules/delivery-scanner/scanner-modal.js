// Lieferschein-Erfassung: Fotos aufnehmen → Ecken prüfen/entzerren → Texterkennung → Abgleich prüfen → buchen.
// Registriert sich in den Slots 'order-detail-actions' und 'dashboard-actions'.
import Alpine from '../../vendor/alpinejs@3.17.5/dist/module.esm.js';
import { registerPlugin } from '../../core/plugin-registry.js';
import { DELIVERY_STATUSES, supplierLabel } from '../../core/config.js';
import { pb } from '../../core/pb.js';
import { listOrderItems, getOrder, bookDelivery, uploadAttachments, backlogOf, errorMessage } from '../../core/api.js';
import { toast, confirmAction } from '../../core/ui.js';
import { loadVision, fileToCanvas, detectCorners, defaultCorners, rectify, toGrayJpeg, toJpeg } from './vision.js';
import { preloadOcr, recognizePage, terminateOcr } from './ocr.js';
import { extractRows, matchRows, orderNumberTokens, rankOrders } from './matcher.js';
import { detectProfile, profileForSupplier } from './profiles/index.js';
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
          <canvas x-ref="cornerCanvas" class="w-full touch-none rounded-lg border border-slate-200"
                  @pointerdown="cornerDown($event)" @pointermove="cornerMove($event)"
                  @pointerup="cornerUp($event)" @pointercancel="cornerUp($event)"></canvas>
          <div class="mt-3 flex flex-wrap justify-end gap-2">
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
                        <div class="truncate text-xs text-slate-600" x-text="r.name"></div>
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
                    <li class="flex flex-wrap items-center gap-2 text-sm">
                      <span class="font-mono" x-text="u.qty + ' × ' + u.part"></span>
                      <select class="input ml-auto w-auto" x-model="u.assignTo" :disabled="u.assigned" @change="assignUnmatched(u)">
                        <option value="">– zuordnen –</option>
                        <template x-for="r in reviewRows" :key="r.itemId">
                          <option :value="r.itemId" x-text="r.part"></option>
                        </template>
                      </select>
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
  let pageCounter = 0;

  return {
    isOpen: false,
    step: 'pages',
    libState: 'idle',
    libError: '',
    busyText: '',
    pages: [], // [{ id, thumb }]
    cornersDetected: true,
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
      if (this.pages.length && !confirmAction('Erfassung abbrechen? Aufgenommene Seiten gehen verloren.')) return;
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
      Object.assign(this, {
        step: 'pages', busyText: '', pages: [], cornersDetected: true, progress: { value: 0, label: '' },
        order: null, items: [], lockedOrder: false, orderCandidates: [], selectedOrderId: '', detectedOrderHint: '',
        warnings: [], reviewRows: [], unmatched: [], note: '', busy: false,
        problems: [], recognitionFailed: false, reportOpen: false, reportNote: '', reportBusy: false, reported: false,
      });
    },

    orderLabel() {
      if (!this.order) return 'Bestellung wird nach der Erkennung zugeordnet';
      return supplierLabel(this.order) + (this.order.supplier_order_no ? ' · Auftrag ' + this.order.supplier_order_no : '');
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
    },

    cornerUp(event) {
      if (source?.drag) event.target.releasePointerCapture?.(event.pointerId);
      if (source) source.drag = null;
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
      this.warnings = [];

      if (!this.lockedOrder) {
        await this.loadOrderCandidates(detected, ocrPages);
      } else if (detected && detected.supplier !== this.order.supplier) {
        this.warnings.push(`Der Lieferschein sieht nach ${detected.label} aus, die Bestellung ist aber bei ${supplierLabel(this.order)}. Bitte prüfen.`);
      }
      this.computeReview();
      this.updateAssessment();
    },

    async loadOrderCandidates(detected, ocrPages) {
      const statusFilter = DELIVERY_STATUSES.filter((s) => s !== 'geliefert').map((s) => `status = "${s}"`).join(' || ');
      const filter = detected ? `(${statusFilter}) && supplier = "${detected.supplier}"` : statusFilter;
      const orders = await pb.collection('orders').getFullList({ filter, sort: '-updated' });
      const ranked = rankOrders(orders, orderNumberTokens(ocrPages[0]));
      this.orderCandidates = ranked.map(({ order }) => ({
        id: order.id,
        label: supplierLabel(order) + ' · ' + (order.supplier_order_no || 'ohne Auftragsnummer'),
      }));
      const top = ranked[0];
      const clear = top && (top.sim >= 0.8 || ranked.length === 1) && (ranked.length === 1 || top.sim - ranked[1].sim >= 0.1);
      this.detectedOrderHint = detected ? `Erkannter Lieferant: ${detected.label}.` : 'Lieferant nicht erkannt.';
      if (clear) {
        this.detectedOrderHint += top.sim >= 0.8 ? ' Bestellung über die Auftragsnummer zugeordnet – bitte prüfen.' : ' Einzige offene Bestellung vorausgewählt – bitte prüfen.';
        await this.selectOrder(top.order.id);
      } else if (!ranked.length) {
        this.warnings.push('Keine offene Bestellung für diesen Lieferanten gefunden.');
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
      const profile = profileForSupplier(this.order.supplier);
      const rows = [];
      const missingHeader = [];
      if (profile) {
        pageData.forEach((p, page) => {
          const res = extractRows(p.ocr, profile);
          if (!res.headerFound) missingHeader.push(page + 1);
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
        .map((a, i) => ({ key: i, part: a.row.part, qty: a.row.qty, assignTo: '', assigned: false }));
    },

    updateAssessment() {
      const { failed, problems } = assessRecognition({
        pages: pageData.map((p) => p.meta),
        detectedProfile,
        order: this.order,
        orderProfile: this.order ? profileForSupplier(this.order.supplier) : null,
        missingHeader: extracted.missingHeader,
        rows: extracted.rows,
        assignments,
      });
      this.recognitionFailed = failed;
      this.problems = problems;
    },

    assignUnmatched(u) {
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
      return this.reviewRows.some((r) => Number(r.qty) !== 0);
    },

    async buildPdf() {
      const pdf = await jpegsToPdf(pageData.map((p) => p.jpeg));
      if (pdf.length > MAX_RECEIPT_BYTES) {
        throw new Error(`Der Beleg ist mit ${(pdf.length / 1048576).toFixed(1)} MB zu groß (max. 15 MB).`);
      }
      const date = new Date().toISOString().slice(0, 10);
      return new File([pdf], `lieferschein-${this.order.supplier}-${date}.pdf`, { type: 'application/pdf' });
    },

    async book() {
      const invalid = this.reviewRows.find((r) => !Number.isInteger(Number(r.qty)));
      if (invalid) {
        toast.error(`Ungültige Menge bei ${invalid.part}.`);
        return;
      }
      const lines = this.reviewRows.filter((r) => Number(r.qty) !== 0).map((r) => ({ item: r.itemId, qty: Number(r.qty) }));
      const unchecked = this.reviewRows.filter((r) => r.status === 'check' && Number(r.qty) !== 0).length;
      if (unchecked && !confirmAction(`${unchecked} Position(en) sind zur Prüfung markiert. Trotzdem buchen?`)) return;

      this.busy = true;
      try {
        const receipt = await this.buildPdf();
        if (lines.length) {
          await bookDelivery(this.order.id, lines, { note: this.note, receipt });
          toast.success(`Lieferung mit ${lines.length} Position(en) gebucht, Beleg angehängt.`);
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
