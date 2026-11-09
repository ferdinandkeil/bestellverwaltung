// Gemeinsame Hilfsfunktionen für die Hooks (CommonJS, wird per require() geladen).

const SUPPLIERS = ["mouser", "farnell", "reichelt", "voelkner", "other"];
const STATUSES = ["angefragt", "bestellt", "teilgeliefert", "geliefert", "geprueft", "abgerechnet"];
/** Status, in denen der Lieferstatus automatisch berechnet wird. */
const AUTO_STATUSES = ["bestellt", "teilgeliefert", "geliefert"];
/** Status, in denen Positionen bearbeitet und Lieferungen gebucht werden dürfen. */
const DELIVERY_STATUSES = AUTO_STATUSES;

/**
 * Bestellnummer normalisieren: Großbuchstaben, Leerraum (auch Tabulator, geschützte und unsichtbare
 * Leerzeichen aus kopierten Texten) zu einem Leerzeichen zusammengefasst, außen getrimmt.
 * Einzelne Leerzeichen bleiben – sie gehören z. B. bei Reichelt zur Nummer („MKDS 1,5 3 5,08“).
 */
function normalizePartNumber(value) {
  return String(value == null ? "" : value)
    .replace(/[\s\u200B\u2060]+/g, " ")
    .trim()
    .toUpperCase();
}

/** Interne Bestellnummer der Hochschule: JJJJIW##### (z. B. 2026IW01047). */
const INTERNAL_ORDER_NO_RE = /^[0-9]{4}IW[0-9]{5}$/;

function normalizeInternalOrderNo(value) {
  return String(value == null ? "" : value).trim().toUpperCase();
}

function normalizeShopName(value) {
  return String(value == null ? "" : value).trim();
}

/** Liest ein JSON-Feld eines Records als JS-Wert. */
function readJSON(record, field, fallback) {
  const raw = record.getString(field);
  if (!raw || raw === "null") return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

/** Ganzzahl > 0 aus beliebiger Eingabe, sonst Fehler. */
function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new BadRequestError(label + " muss eine ganze Zahl ≥ 1 sein.");
  }
  return n;
}

/** Ganzzahl ≠ 0 aus beliebiger Eingabe, sonst Fehler. */
function nonZeroInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n === 0) {
    throw new BadRequestError(label + " muss eine ganze Zahl ≠ 0 sein.");
  }
  return n;
}

module.exports = {
  SUPPLIERS,
  STATUSES,
  AUTO_STATUSES,
  DELIVERY_STATUSES,
  normalizePartNumber,
  normalizeShopName,
  INTERNAL_ORDER_NO_RE,
  normalizeInternalOrderNo,
  readJSON,
  positiveInt,
  nonZeroInt,
};
