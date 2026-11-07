// Verwaltung der Studierenden-Gruppen und Projekt-Status-Ansicht je Gruppe.
import { supplierLabel, statusMeta } from '../core/config.js';
import {
  listGroups, createGroup, updateGroup, deleteGroup, listItemsForGroup, backlogOf, subscribe, errorMessage,
} from '../core/api.js';
import { toast, confirmAction } from '../core/ui.js';

const EMPTY = { name: '', semester: '', contact_info: '', is_active: true };

const template = /* html */ `
<div x-data="groupsView" class="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
  <!-- Gruppenliste -->
  <section>
    <div class="mb-3 flex items-center gap-2">
      <h1 class="mr-auto text-xl font-semibold">Gruppen / Projekte</h1>
      <button type="button" class="btn btn-primary" @click="startCreate()">+ Gruppe</button>
    </div>

    <label class="mb-2 flex items-center gap-2 text-sm text-slate-600">
      <input type="checkbox" x-model="showInactive"> Inaktive Gruppen anzeigen
    </label>

    <p x-show="error" x-text="error" class="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>

    <ul class="space-y-2">
      <template x-for="g in visibleGroups()" :key="g.id">
        <li class="card cursor-pointer p-3 transition hover:border-blue-300"
            :class="selected?.id === g.id && 'border-blue-400 ring-2 ring-blue-100'" @click="select(g)">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="font-medium" :class="!g.is_active && 'text-slate-400'" x-text="g.name"></div>
              <div class="text-xs text-slate-500" x-text="[g.semester, g.contact_info].filter(Boolean).join(' · ')"></div>
            </div>
            <span x-show="!g.is_active" class="badge bg-slate-100 text-slate-500 ring-slate-300">inaktiv</span>
            <button type="button" class="btn btn-ghost btn-sm" @click.stop="startEdit(g)">Bearbeiten</button>
          </div>
        </li>
      </template>
    </ul>
    <p x-show="!visibleGroups().length && !error" class="card p-6 text-center text-sm text-slate-500">Keine Gruppen.</p>
  </section>

  <!-- Projekt-Status der gewählten Gruppe -->
  <section>
    <template x-if="!selected">
      <p class="card p-6 text-center text-sm text-slate-500">Gruppe auswählen, um ihre bestellten Teile zu sehen.</p>
    </template>
    <template x-if="selected">
      <div class="card p-4">
        <h2 class="text-lg font-semibold" x-text="selected.name"></h2>
        <p class="mb-3 text-xs text-slate-500">
          Rückstand und Status beziehen sich auf die gesamte Sammelposition, nicht nur auf den Anteil der Gruppe.
        </p>
        <p x-show="loadingItems" class="text-sm text-slate-500">Lade …</p>
        <p x-show="!loadingItems && !items.length" class="text-sm text-slate-500">Für diese Gruppe wurde noch nichts erfasst.</p>
        <ul class="divide-y divide-slate-100">
          <template x-for="it in items" :key="it.id">
            <li class="py-2">
              <a :href="'#/orders/' + it.order" class="flex items-start gap-2 hover:text-blue-700">
                <div class="min-w-0 flex-1">
                  <div class="font-mono text-sm font-semibold break-all" x-text="it.part_number"></div>
                  <div class="text-sm text-slate-700" x-text="it.name"></div>
                  <div class="text-xs text-slate-500" x-text="supplierLabel(it.expand?.order)"></div>
                </div>
                <div class="shrink-0 text-right">
                  <span class="badge" :class="statusMeta(it.expand?.order?.status).badge" x-text="statusMeta(it.expand?.order?.status).label"></span>
                  <div class="mt-1 text-xs">
                    Anteil <strong x-text="shareOf(it) + ' Stk.'"></strong>
                  </div>
                  <div class="text-xs" :class="backlogOf(it) ? 'text-amber-700' : 'text-emerald-700'"
                       x-text="backlogOf(it) ? 'Rückstand ' + backlogOf(it) : 'vollständig'"></div>
                </div>
              </a>
            </li>
          </template>
        </ul>
      </div>
    </template>
  </section>

  <!-- Modal: Gruppe anlegen/bearbeiten -->
  <div x-show="form.open" x-transition.opacity class="modal-backdrop" @click.self="form.open = false"
       @keydown.escape.window="form.open = false">
    <form class="modal-panel space-y-3" @submit.prevent="save()">
      <h2 class="text-lg font-semibold" x-text="form.id ? 'Gruppe bearbeiten' : 'Neue Gruppe'"></h2>
      <div>
        <label class="label">Name</label>
        <input class="input" x-model="form.data.name" required maxlength="150" x-ref="groupName">
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label">Semester</label>
          <input class="input" x-model="form.data.semester" maxlength="50" placeholder="z. B. WS 26/27">
        </div>
        <div class="flex items-end pb-2">
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" x-model="form.data.is_active"> aktiv</label>
        </div>
      </div>
      <div>
        <label class="label">Kontakt</label>
        <input class="input" x-model="form.data.contact_info" maxlength="250" placeholder="Name, E-Mail …">
      </div>
      <div class="flex flex-wrap gap-2 pt-1">
        <template x-if="form.id">
          <button type="button" class="btn btn-danger" @click="remove()">Löschen</button>
        </template>
        <button type="button" class="btn btn-secondary ml-auto" @click="form.open = false">Abbrechen</button>
        <button type="submit" class="btn btn-primary" :disabled="busy">Speichern</button>
      </div>
    </form>
  </div>
</div>`;

function component() {
  return {
    supplierLabel, statusMeta, backlogOf,
    groups: [],
    showInactive: false,
    selected: null,
    items: [],
    loadingItems: false,
    error: '',
    busy: false,
    form: { open: false, id: null, data: { ...EMPTY } },
    unsubscribe: null,

    async init() {
      await this.reload();
      try {
        this.unsubscribe = await subscribe(['groups', 'order_items', 'orders'], () => {
          this.reload();
          if (this.selected) this.loadItems();
        });
      } catch (err) {
        console.warn('Realtime nicht verfügbar', err);
      }
    },

    destroy() {
      this.unsubscribe?.();
    },

    async reload() {
      try {
        this.groups = await listGroups();
        if (this.selected) this.selected = this.groups.find((g) => g.id === this.selected.id) ?? null;
        this.error = '';
      } catch (err) {
        this.error = errorMessage(err);
      }
    },

    visibleGroups() {
      return this.showInactive ? this.groups : this.groups.filter((g) => g.is_active);
    },

    async select(g) {
      this.selected = g;
      await this.loadItems();
    },

    async loadItems() {
      this.loadingItems = true;
      try {
        this.items = await listItemsForGroup(this.selected.id);
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.loadingItems = false;
      }
    },

    shareOf(it) {
      return (it.group_allocations || [])
        .filter((a) => a.groupId === this.selected?.id)
        .reduce((s, a) => s + (a.qty || 0), 0);
    },

    startCreate() {
      this.form = { open: true, id: null, data: { ...EMPTY } };
      this.$nextTick(() => this.$refs.groupName?.focus());
    },

    startEdit(g) {
      this.form = {
        open: true,
        id: g.id,
        data: { name: g.name, semester: g.semester || '', contact_info: g.contact_info || '', is_active: !!g.is_active },
      };
    },

    async save() {
      this.busy = true;
      try {
        if (this.form.id) await updateGroup(this.form.id, this.form.data);
        else await createGroup(this.form.data);
        this.form.open = false;
        await this.reload();
        toast.success('Gruppe gespeichert.');
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        this.busy = false;
      }
    },

    async remove() {
      if (!confirmAction(`Gruppe „${this.form.data.name}“ löschen? Bestehende Gruppen-Hinweise in Positionen bleiben als Text erhalten.`)) return;
      try {
        await deleteGroup(this.form.id);
        if (this.selected?.id === this.form.id) this.selected = null;
        this.form.open = false;
        await this.reload();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
  };
}

export default { dataName: 'groupsView', template, component };
