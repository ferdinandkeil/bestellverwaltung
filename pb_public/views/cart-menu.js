// Warenkorb (ARCHITECTURE.md Kap. 7): ab sm Symbol in der Kopfzeile mit Zahl der offenen Positionen, ein Klick klappt
// die Warenkörbe auf, darunter rechts „+ Position erfassen“. Auf dem Smartphone runder Knopf unten rechts (fest),
// der die eigene Seite #/carts öffnet; dort führt ✕ zur vorigen Ansicht zurück.
// Das Formular „Position erfassen“ ist seitenweit verfügbar (Ereignis `open-item-form`).
// Links neben dem Warenkorb: Module im Slot 'header-actions' als Symbol (z. B. Moodle-Import).
import Alpine from '../vendor/alpinejs@3.17.5/dist/module.esm.js';
import { supplierLabel } from '../core/config.js';
import { listOpenCarts, subscribe, errorMessage } from '../core/api.js';
import { getPlugins } from '../core/plugin-registry.js';
import { toast } from '../core/ui.js';
import { itemFormFields } from './item-form.js';

/** Positionen je Korb im ausgeklappten Feld; der Rest steht hinter „+ n weitere →“. */
const PREVIEW_ITEMS = 5;
/** Seite Warenkörbe über den Knopf geöffnet → ✕ geht im Verlauf zurück; sonst (direkt aufgerufen) zur Startseite. */
let openedFromApp = false;

function openCartsPage() {
  openedFromApp = true;
  location.hash = '#/carts';
}

const CART_ICON = /* html */ `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-6" aria-hidden="true">
  <path d="M3 4h2l2.4 10.2a1.5 1.5 0 0 0 1.5 1.1h8.3a1.5 1.5 0 0 0 1.4-1.1L20.5 8H6.2"/>
  <circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>
</svg>`;

/** Liste der Warenkörbe – im Ausklappfeld (limit = PREVIEW_ITEMS) und auf der Seite (alle Positionen). */
const CART_LIST = /* html */ `
<p x-show="$store.carts.error" x-text="$store.carts.error" class="my-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>
<p x-show="$store.carts.loaded && !$store.carts.list.length" class="py-6 text-center text-sm text-slate-500">
  Keine offenen Warenkörbe.
</p>
<ul class="divide-y divide-slate-100" data-cart-list>
  <template x-for="c in $store.carts.list" :key="c.id">
    <li class="py-3" data-cart>
      <a :href="'#/orders/' + c.id" class="flex items-baseline justify-between gap-2 rounded hover:text-blue-700">
        <span class="font-semibold" x-text="supplierLabel(c)"></span>
        <span class="shrink-0 text-xs text-slate-500" x-text="positionsLabel(c)"></span>
      </a>
      <ul class="mt-1.5 space-y-1 text-sm">
        <template x-for="it in visibleItems(c)" :key="it.id">
          <li class="flex items-baseline gap-2">
            <span class="w-12 shrink-0 text-right tabular-nums text-slate-500" x-text="it.qty_ordered + ' ×'"></span>
            <span class="min-w-0 flex-1 truncate" :title="it.part_number + (it.name ? ' · ' + it.name : '')">
              <span class="font-mono text-xs" x-text="it.part_number"></span><span x-show="it.name" class="text-slate-600" x-text="' · ' + it.name"></span>
            </span>
          </li>
        </template>
      </ul>
      <a x-show="hiddenCount(c)" :href="'#/orders/' + c.id" class="mt-1 ml-14 inline-block text-xs font-medium text-blue-700 hover:underline"
         x-text="'+ ' + hiddenCount(c) + ' weitere →'" data-cart-more></a>
    </li>
  </template>
</ul>`;

const CART_ACTIONS = /* html */ `
<button type="button" class="btn btn-primary ml-auto" @click="addItem()" data-add-item>+ Position erfassen</button>`;

/** Symbole der Module im Slot 'header-actions' (Schlüssel = plugin.icon). */
const HEADER_ICONS = {
  upload: '<path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
};

/** Module als Symbol links neben dem Warenkorb (ab sm; auf dem Smartphone wird nur gescannt). */
export const headerActionsTemplate = /* html */ `
<div x-data="headerActions" class="hidden items-center sm:flex">
  <template x-for="p in plugins()" :key="p.id">
    <button type="button" class="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100" @click="run(p)"
            x-tip="p.label" :aria-label="p.label" :data-header-action="p.id">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
           class="size-6" aria-hidden="true" x-html="icon(p)"></svg>
    </button>
  </template>
</div>`;

/** Symbol + Ausklappfeld in der Kopfzeile (index.html). */
export const cartMenuTemplate = /* html */ `
<div x-data="cartMenu" class="relative" @keydown.escape.window="open = false" @click.outside="open = false">
  <button type="button" class="relative rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
          :class="(open || $store.route.name === 'carts') && 'bg-blue-50 text-blue-700'"
          @click="toggle()" :aria-expanded="open" :aria-label="buttonLabel()" :title="buttonLabel()" data-cart-button>
    ${CART_ICON}
    <span x-show="$store.carts.count" x-text="$store.carts.count" data-cart-count
          class="absolute -top-0.5 -right-0.5 min-w-5 rounded-full bg-blue-600 px-1 text-center text-[11px] leading-5 font-semibold text-white"></span>
  </button>
  <div x-show="open" x-transition.origin.top.right data-cart-panel
       class="absolute top-full right-0 z-40 mt-2 flex max-h-[calc(100dvh-5rem)] w-[26rem] flex-col rounded-xl border border-slate-200 bg-white text-slate-900 shadow-xl">
    <h2 class="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Warenkörbe</h2>
    <div class="min-h-0 flex-1 overflow-y-auto px-4">${CART_LIST}</div>
    <div class="flex border-t border-slate-100 px-4 py-3">${CART_ACTIONS}</div>
  </div>
</div>`;

/**
 * Smartphone: runder Warenkorb-Knopf unten rechts (fest), mit Zahl der offenen Positionen. Nicht auf der Seite
 * Warenkörbe selbst; Dialoge (z-40) und die Auswahlleiste der Favoriten (z-20) liegen darüber.
 */
export const cartFabTemplate = /* html */ `
<button type="button" x-data x-show="$store.auth.user && $store.route.name !== 'carts' && $store.route.name !== 'login'"
        class="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-10 flex size-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-900/20 active:bg-blue-700 sm:hidden"
        @click="$store.carts.openPage()" :aria-label="$store.carts.label()" data-cart-fab>
  ${CART_ICON.replace('size-6', 'size-7')}
  <span x-show="$store.carts.count" x-text="$store.carts.count" data-cart-count
        class="absolute -top-1 -right-1 min-w-6 rounded-full bg-white px-1.5 text-center text-xs leading-6 font-bold text-blue-700 ring-2 ring-blue-600"></span>
</button>`;

/** Formular „Position erfassen“ als Modal, seitenweit (index.html). */
export const itemFormModalTemplate = /* html */ `
<div x-data="{ show: false }" x-show="show" x-transition.opacity class="modal-backdrop"
     @open-item-form.window="show = true" @keydown.escape.window="show = false" @click.self="show = false">
  <div class="modal-panel" @item-form-cancel="show = false">
    <h2 class="mb-4 text-lg font-semibold">Position erfassen</h2>
    <template x-if="show">
      <div x-data="itemForm({})">${itemFormFields}</div>
    </template>
  </div>
</div>`;

/** Eigene Seite #/carts (Smartphone): alle Positionen, Aktionen oben. */
const pageTemplate = /* html */ `
<div x-data="cartsView">
  <div class="mb-3 flex items-center gap-2">
    <h1 class="mr-auto text-xl font-semibold">Warenkörbe</h1>
    <button type="button" class="-mr-2 rounded-lg p-2 text-slate-600 hover:bg-slate-100" @click="close()" aria-label="Schließen" data-carts-close>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="size-6" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>
  </div>
  <div class="mb-2 flex">${CART_ACTIONS}</div>
  <div class="card px-4">${CART_LIST}</div>
</div>`;

/** Gemeinsame Helfer für Ausklappfeld und Seite. */
function cartHelpers(limit) {
  return {
    supplierLabel,
    positionsLabel(c) {
      const n = c.expand?.order_items_via_order?.length ?? 0;
      return n === 1 ? '1 Position' : `${n} Positionen`;
    },
    visibleItems(c) {
      const items = c.expand?.order_items_via_order ?? [];
      return limit ? items.slice(0, limit) : items;
    },
    hiddenCount(c) {
      const n = c.expand?.order_items_via_order?.length ?? 0;
      return limit ? Math.max(0, n - limit) : 0;
    },
    addItem() {
      window.dispatchEvent(new CustomEvent('open-item-form'));
    },
  };
}

/**
 * Store 'carts': offene Warenkörbe mit Positionen, nach dem Login geladen und per Realtime aktuell gehalten.
 * count = Anzahl der Positionen über alle Körbe (nicht Stückzahlen).
 */
function registerCartsStore() {
  Alpine.store('carts', {
    list: [],
    loaded: false,
    error: '',
    get count() {
      return this.list.reduce((n, c) => n + (c.expand?.order_items_via_order?.length ?? 0), 0);
    },
    label() {
      const n = this.count;
      return n ? `Warenkörbe (${n} ${n === 1 ? 'Position' : 'Positionen'})` : 'Warenkörbe';
    },
    openPage: openCartsPage,
    async load() {
      try {
        const list = await listOpenCarts();
        this.list = list.sort((a, b) => supplierLabel(a).localeCompare(supplierLabel(b), 'de'));
        this.error = '';
      } catch (err) {
        this.error = errorMessage(err);
      } finally {
        this.loaded = true;
      }
    },
  });
  const store = Alpine.store('carts');
  let unsubscribe = null;
  let userId = null;
  Alpine.effect(() => {
    const id = Alpine.store('auth').user?.id ?? null;
    if (id === userId) return;
    userId = id;
    unsubscribe?.();
    unsubscribe = null;
    store.list = [];
    store.loaded = false;
    if (!id) return;
    store.load();
    subscribe(['orders', 'order_items'], () => store.load())
      .then((unsub) => {
        if (userId === id) unsubscribe = unsub; else unsub();
      })
      .catch((err) => console.warn('Realtime nicht verfügbar', err));
  });
}

export function registerCartMenu() {
  registerCartsStore();
  Alpine.data('cartMenu', () => ({
    ...cartHelpers(PREVIEW_ITEMS),
    open: false,
    init() {
      // Beim Wechsel der Ansicht (z. B. Klick auf einen Korb) schließen.
      this.onHash = () => { this.open = false; };
      window.addEventListener('hashchange', this.onHash);
    },
    destroy() {
      window.removeEventListener('hashchange', this.onHash);
    },
    buttonLabel() {
      return this.$store.carts.label();
    },
    toggle() {
      this.open = !this.open;
      if (this.open) this.$store.carts.load();
    },
    addItem() {
      this.open = false;
      window.dispatchEvent(new CustomEvent('open-item-form'));
    },
  }));
  Alpine.data('headerActions', () => ({
    plugins() {
      void this.$store.plugins.version; // reaktiv bei nachgeladenen Modulen
      return getPlugins('header-actions');
    },
    icon(p) {
      return HEADER_ICONS[p.icon] ?? HEADER_ICONS.upload;
    },
    run(p) {
      try {
        p.onClick();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
  }));
}

export default {
  dataName: 'cartsView',
  template: pageTemplate,
  component: () => ({
    ...cartHelpers(0),
    init() {
      this.$store.carts.load();
    },
    /** ✕: zurück zur vorigen Ansicht (wie „Zurück“ im Browser); direkt aufgerufen → Startseite. */
    close() {
      if (openedFromApp) {
        openedFromApp = false;
        history.back();
      } else {
        location.hash = '#/';
      }
    },
  }),
};
