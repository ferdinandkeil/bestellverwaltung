// Gemeinsame Hilfsfunktionen für die Hooks (CommonJS, wird per require() geladen).

const SUPPLIERS = ["mouser", "farnell", "reichelt", "voelkner", "other"];
const STATUSES = ["angefragt", "bestellt", "teilgeliefert", "geliefert", "geprueft", "abgerechnet"];
/** Status, in denen der Lieferstatus automatisch berechnet wird. */
const AUTO_STATUSES = ["bestellt", "teilgeliefert", "geliefert"];
/** Status, in denen Positionen bearbeitet und Lieferungen gebucht werden dürfen. */
const DELIVERY_STATUSES = AUTO_STATUSES;

function normalizePartNumber(value) {
  return String(value == null ? "" : value).trim().toUpperCase();
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
