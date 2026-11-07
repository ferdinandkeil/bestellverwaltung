// PocketBase-Instanz, Email-OTP-Login und Session-Handling.
import PocketBase from '../vendor/pocketbase@0.28.1/dist/pocketbase.es.mjs';

export const pb = new PocketBase(window.location.origin);
// Mehrere gleichzeitige Anfragen (z. B. Realtime-Reload) nicht automatisch abbrechen.
pb.autoCancellation(false);

/** Schritt 1: Code anfordern. Liefert die otpId (auch für unbekannte Adressen, ohne Mail). */
export async function requestOTP(email) {
  const res = await pb.collection('users').requestOTP(email.trim());
  return res.otpId;
}

/** Schritt 2: Code prüfen und anmelden. */
export async function verifyOTP(otpId, code) {
  return pb.collection('users').authWithOTP(otpId, code.trim());
}

export function logout() {
  pb.realtime.unsubscribe();
  pb.authStore.clear();
}

export function currentUser() {
  return pb.authStore.isValid ? pb.authStore.record : null;
}

/** Beim App-Start: gültiges Token verlängern (Session bleibt 30 Tage ab letzter Nutzung). */
export async function refreshSession() {
  if (!pb.authStore.isValid) {
    pb.authStore.clear();
    return null;
  }
  try {
    await pb.collection('users').authRefresh();
    return pb.authStore.record;
  } catch (err) {
    // Nur bei echter Ablehnung abmelden, nicht bei Netzwerkfehlern (Labor-WLAN).
    if (err?.status === 401 || err?.status === 403 || err?.status === 404) pb.authStore.clear();
    return currentUser();
  }
}

/** Callback bei jeder Änderung des Login-Zustands. Gibt eine Abmeldefunktion zurück. */
export function onAuthChange(callback) {
  return pb.authStore.onChange(() => callback(currentUser()));
}
