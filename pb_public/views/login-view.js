// Zweistufige Email-OTP-Anmeldung.
import { requestOTP, verifyOTP } from '../core/pb.js';
import { errorMessage } from '../core/api.js';

const template = /* html */ `
<div x-data="loginView" class="mx-auto mt-10 max-w-sm sm:mt-20">
  <div class="card p-6">
    <h1 class="text-lg font-semibold">Labor-Bestellsystem</h1>
    <p class="mt-1 text-sm text-slate-500">Anmeldung per E-Mail-Code</p>

    <form x-show="step === 'email'" @submit.prevent="sendCode" class="mt-6 space-y-4">
      <div>
        <label class="label" for="login-email">E-Mail-Adresse</label>
        <input id="login-email" class="input" type="email" autocomplete="email" required
               x-model="email" x-ref="email" placeholder="name@hochschule.de">
      </div>
      <button type="submit" class="btn btn-primary w-full" :disabled="busy">
        <span x-text="busy ? 'Wird gesendet …' : 'Code anfordern'"></span>
      </button>
    </form>

    <form x-show="step === 'code'" @submit.prevent="checkCode" class="mt-6 space-y-4">
      <p class="text-sm text-slate-600">
        Falls für <strong x-text="email"></strong> ein Konto existiert, wurde ein Code verschickt.
        Er ist 10 Minuten gültig.
      </p>
      <div>
        <label class="label" for="login-code">Code</label>
        <input id="login-code" class="input text-center font-mono text-lg tracking-widest" inputmode="numeric"
               autocomplete="one-time-code" required x-model="code" x-ref="code" maxlength="12">
      </div>
      <button type="submit" class="btn btn-primary w-full" :disabled="busy">
        <span x-text="busy ? 'Wird geprüft …' : 'Anmelden'"></span>
      </button>
      <div class="flex justify-between text-xs">
        <button type="button" class="text-blue-700 hover:underline" @click="back()">Andere Adresse</button>
        <button type="button" class="text-blue-700 hover:underline" @click="sendCode()" :disabled="busy">Code erneut senden</button>
      </div>
      <p class="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
        Kein Code erhalten? Bitte auch den Spam-Ordner prüfen. Ihr Konto muss vom Admin angelegt sein.
      </p>
    </form>

    <p x-show="error" x-text="error" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>
  </div>
</div>`;

function component() {
  return {
    step: 'email',
    email: '',
    code: '',
    otpId: '',
    busy: false,
    error: '',

    init() {
      this.$nextTick(() => this.$refs.email?.focus());
    },

    async sendCode() {
      this.error = '';
      this.busy = true;
      try {
        this.otpId = await requestOTP(this.email);
        this.step = 'code';
        this.code = '';
        this.$nextTick(() => this.$refs.code?.focus());
      } catch (err) {
        this.error = errorMessage(err);
      } finally {
        this.busy = false;
      }
    },

    async checkCode() {
      this.error = '';
      this.busy = true;
      try {
        await verifyOTP(this.otpId, this.code);
        location.hash = '#/';
      } catch (err) {
        if (err?.status === 400) {
          this.error = 'Der Code ist falsch oder abgelaufen.';
        } else if (err?.status === 429) {
          this.error = 'Zu viele Fehlversuche. Bitte einige Minuten warten und dann einen neuen Code anfordern.';
        } else {
          this.error = errorMessage(err);
        }
      } finally {
        this.busy = false;
      }
    },

    back() {
      this.step = 'email';
      this.error = '';
      this.$nextTick(() => this.$refs.email?.focus());
    },
  };
}

export default { dataName: 'loginView', template, component };
