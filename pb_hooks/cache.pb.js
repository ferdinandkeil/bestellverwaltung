/// <reference path="../pb_data/types.d.ts" />
// Oberfläche (pb_public) immer mit dem Server abgleichen: `Cache-Control: no-cache` (ARCHITECTURE.md Kap. 9).
// PocketBase liefert statische Dateien nur mit Last-Modified aus; ohne Cache-Control entscheidet der Browser
// selbst, wie lange er sie ungefragt weiterverwendet – nach einem Deploy liefen dann alte und neue Module
// gemischt (Firefox lädt per import() nachgeladene Module auch bei Strg+Umschalt+R aus dem Cache).
// Mit no-cache fragt der Browser jedes Mal nach; unveränderte Dateien kosten nur ein „304 Not Modified“.
// API (/api/…, inkl. Dateianhänge mit eigenen Regeln) und Admin-Oberfläche (/_/) bleiben unberührt.
routerUse((e) => {
  const path = e.request.url.path;
  if (!path.startsWith('/api/') && !path.startsWith('/_/')) {
    e.response.header().set('Cache-Control', 'no-cache');
  }
  return e.next();
});
