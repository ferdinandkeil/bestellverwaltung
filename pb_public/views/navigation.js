// Navigation (ARCHITECTURE.md Kap. 7): dieselben Symbole am PC (Kopfzeile, Symbol + Text) und auf dem Smartphone
// (untere Leiste, nur Symbol), damit man sich in beiden Ansichten wiedererkennt.
//   ab sm:        Kopfzeile mit Bestellungen, Gruppen/Projekte, Favoriten
//   Smartphone:   feste Leiste unten – links Bestellungen, Favoriten, Warenkorb als eine Pille, rechts daneben rund die
//                 Module im Slot 'bottom-bar' (Lieferschein-Scanner); Hamburger-Menü mit Gruppen/Projekte, Name,
//                 Logout und Version (statt Fußzeile). Die Leiste verschwindet, solange ein Textfeld fokussiert ist
//                 (Bildschirmtastatur).
import Alpine from '../vendor/alpinejs@3.17.5/dist/module.esm.js';
import { getPlugins } from '../core/plugin-registry.js';
import { toast } from '../core/ui.js';
import { errorMessage } from '../core/api.js';

const PATHS = {
  orders: '<path d="M9 3.5h6v3H9z"/><path d="M9 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H15"/><path d="M8.5 11h7M8.5 14.5h7M8.5 18h4"/>',
  groups: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17 13.8a5.5 5.5 0 0 1 3.5 5.7"/>',
  favorites: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  cart: '<path d="M3 4h2l2.4 10.2a1.5 1.5 0 0 0 1.5 1.1h8.3a1.5 1.5 0 0 0 1.4-1.1L20.5 8H6.2"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
  upload: '<path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  // Beleg mit Scan-Ecken
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M8.5 9h7M8.5 12h7M8.5 15h4"/>',
};

/** Symbol als SVG (Strichzeichnung, Farbe aus currentColor). */
export function icon(name, cls = 'size-6') {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${PATHS[name] ?? PATHS.upload}</svg>`;
}

/** Symbolpfade für Module (plugin.icon), z. B. in x-html innerhalb eines <svg>. */
export const iconPaths = (name) => PATHS[name] ?? PATHS.upload;

/** Seiten der Hauptnavigation; active: Routen, bei denen der Eintrag hervorgehoben ist. */
const PAGES = {
  orders: { href: '#/', label: 'Bestellungen', active: ['dashboard', 'order'] },
  groups: { href: '#/groups', label: 'Gruppen/Projekte', active: ['groups'] },
  favorites: { href: '#/favorites', label: 'Favoriten', active: ['favorites', 'favorite'] },
};
const isActive = (key) => `${JSON.stringify(PAGES[key].active)}.includes($store.route.name)`.replaceAll('"', "'");

/** Kopfzeile ab sm: Symbol + Text. */
export const headerNavTemplate = Object.entries(PAGES).map(([key, p]) => /* html */ `
  <a href="${p.href}" class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5" data-nav="${key}"
     :class="${isActive(key)} ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-600 hover:bg-slate-100'">
    ${icon(key, 'size-5')}<span>${p.label}</span>
  </a>`).join('');

/** Hamburger-Menü (Smartphone): was nicht in der unteren Leiste steht. */
export const mobileMenuTemplate = /* html */ `
  <a href="${PAGES.groups.href}" class="flex items-center gap-3 rounded-lg px-3 py-3" data-nav="groups"
     :class="${isActive('groups')} ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700'">
    ${icon('groups')}<span>${PAGES.groups.label}</span>
  </a>
  <div class="mt-2 flex items-center gap-2 border-t border-slate-100 px-3 pt-3 pb-1">
    <span class="mr-auto truncate text-sm text-slate-500" x-text="$store.auth.user?.name || $store.auth.user?.email"></span>
    <button type="button" class="btn btn-secondary btn-sm" @click="menu = false; $store.auth.logout()">Logout</button>
  </div>
  <p class="px-3 pt-1 pb-1 text-xs text-slate-400" x-show="$store.version.text" x-text="$store.version.text" data-menu-version></p>`;

const PILL_ITEM = 'relative flex h-12 flex-1 items-center justify-center rounded-full';
const PILL_STATE = (active) => `:class="${active} ? 'bg-blue-50 text-blue-700' : 'text-slate-600 active:bg-slate-100'"`;

/** Untere Leiste (Smartphone). Über ihr liegen Dialoge, Scanner und die Auswahlleiste der Favoriten. */
export const bottomBarTemplate = /* html */ `
<nav x-data="bottomBar" x-show="visible()" aria-label="Hauptnavigation" data-bottom-bar
     class="pointer-events-none fixed inset-x-0 bottom-0 z-10 flex items-center gap-3 px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:hidden">
  <div class="pointer-events-auto flex flex-1 items-center gap-1 rounded-full border border-slate-200 bg-white/95 p-1 shadow-lg shadow-slate-900/10 backdrop-blur">
    <a href="${PAGES.orders.href}" class="${PILL_ITEM}" ${PILL_STATE(isActive('orders'))} aria-label="${PAGES.orders.label}" data-bottom-nav="orders">${icon('orders')}</a>
    <a href="${PAGES.favorites.href}" class="${PILL_ITEM}" ${PILL_STATE(isActive('favorites'))} aria-label="${PAGES.favorites.label}" data-bottom-nav="favorites">${icon('favorites')}</a>
    <button type="button" class="${PILL_ITEM}" ${PILL_STATE("$store.route.name === 'carts'")}
            @click="$store.carts.openPage()" :aria-label="$store.carts.label()" data-bottom-nav="carts">
      ${icon('cart')}
      <span x-show="$store.carts.count" x-text="$store.carts.count" data-cart-count
            class="absolute top-0.5 left-1/2 ml-1.5 min-w-5 rounded-full bg-blue-600 px-1 text-center text-[11px] leading-5 font-semibold text-white"></span>
    </button>
  </div>
  <template x-for="p in plugins()" :key="p.id">
    <button type="button" class="pointer-events-auto flex size-14 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-900/20 active:bg-blue-700"
            @click="run(p)" :aria-label="p.label" :data-bottom-action="p.id">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
           class="size-7" aria-hidden="true" x-html="iconPaths(p.icon)"></svg>
    </button>
  </template>
</nav>`;

/** Felder, bei denen die Bildschirmtastatur aufgeht. */
const TYPING = 'textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]):not([type=range])';

export function registerNavigation() {
  // Version für Fußzeile (PC) und Hamburger-Menü: version.json schreibt scripts/deploy.sh auf dem Server; im Repo
  // leer = Entwicklungsstand.
  Alpine.store('version', { text: '' });
  fetch('version.json')
    .then((r) => r.json())
    .then((v) => { Alpine.store('version').text = v.commit ? `Version ${v.date} (${v.commit})` : 'Entwicklungsstand'; })
    .catch(() => {});

  Alpine.data('bottomBar', () => ({
    typing: false,
    iconPaths,
    init() {
      this.onFocusIn = (e) => { this.typing = !!e.target.matches?.(TYPING); };
      this.onFocusOut = () => { this.typing = false; };
      document.addEventListener('focusin', this.onFocusIn);
      document.addEventListener('focusout', this.onFocusOut);
    },
    destroy() {
      document.removeEventListener('focusin', this.onFocusIn);
      document.removeEventListener('focusout', this.onFocusOut);
    },
    visible() {
      return !!this.$store.auth.user && this.$store.route.name !== 'login' && !this.typing;
    },
    plugins() {
      void this.$store.plugins.version; // reaktiv bei nachgeladenen Modulen
      return getPlugins('bottom-bar');
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
