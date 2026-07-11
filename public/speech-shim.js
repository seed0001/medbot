// Inside the Amy Android app (Capacitor), the WebView has no working
// SpeechRecognition. This shim exposes the native Android recognizer
// (@capacitor-community/speech-recognition) through the same interface,
// so the mic code in app.js runs unchanged. In a normal browser it does nothing.
(() => {
  const plugin = window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.SpeechRecognition;
  if (!plugin) return;

  class NativeSpeechRecognition {
    constructor() {
      this.lang = 'en-US';
      this.continuous = false; // native sessions are one utterance; callers restart in onend
      this.interimResults = true;
      this.onresult = null;
      this.onend = null;
      this.onerror = null;
      this._active = false;
      this._discard = false;
      this._lastPartial = '';
      this._sub = null;
    }

    async start() {
      if (this._active) throw new Error('recognition already started');
      this._active = true;
      this._discard = false;
      this._lastPartial = '';
      try {
        const perm = await (plugin.requestPermissions?.() ?? plugin.requestPermission?.() ?? {});
        const state = perm?.speechRecognition || perm?.state || 'granted';
        if (state !== 'granted') return this._fail('not-allowed');
        this._sub = await plugin.addListener('partialResults', (data) => {
          const text = data?.matches?.[0] || '';
          if (!text || !this._active || this._discard) return;
          this._lastPartial = text;
          this._emit(text, false);
        });
        // Resolves (with the final matches) once the recognizer stops listening.
        const res = await plugin.start({ language: this.lang, maxResults: 3, partialResults: true, popup: false });
        const finalText = res?.matches?.[0] || this._lastPartial;
        if (finalText && !this._discard) this._emit(finalText, true);
        this._finish();
      } catch (err) {
        if (!this._active) return;
        const msg = String(err?.message || err).toLowerCase();
        if (msg.includes('permission') || msg.includes('denied')) return this._fail('not-allowed');
        // "No match" / stop() interrupting are normal ends — keep any words we heard.
        if (this._lastPartial && !this._discard) this._emit(this._lastPartial, true);
        this._finish();
      }
    }

    stop() {
      if (this._active) plugin.stop().catch(() => {});
    }

    abort() {
      this._discard = true;
      if (this._active) plugin.stop().catch(() => {});
    }

    _emit(transcript, isFinal) {
      this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript }, isFinal, length: 1 }] });
    }

    _cleanup() {
      this._active = false;
      try { this._sub?.remove(); } catch { /* already gone */ }
      this._sub = null;
    }

    _finish() {
      if (!this._active) return;
      this._cleanup();
      this.onend?.();
    }

    _fail(code) {
      this._cleanup();
      this.onerror?.({ error: code });
      this.onend?.();
    }
  }

  window.SpeechRecognition = NativeSpeechRecognition;
  window.webkitSpeechRecognition = NativeSpeechRecognition; // WebView defines a broken one; override it
})();
