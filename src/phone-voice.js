/** Spoken replies using the device's own text-to-speech voices.
 *
 * Free, needs no download and makes no network request from this package.
 * Replies are split into sentences and queued, so speech starts with the first
 * sentence instead of waiting for the whole reply to be synthesized.
 */
const QUALITY = /natural|neural|enhanced|premium|wavenet|studio|\bhd\b/i;
const LOCALE_ORDER = ['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IE', 'en-IN', 'en-NZ', 'en-ZA'];
const REGION_NAMES = { US: 'US', GB: 'British', AU: 'Australian', CA: 'Canadian', IE: 'Irish', IN: 'Indian', NZ: 'New Zealand', ZA: 'South African', NG: 'Nigerian', SG: 'Singapore', PH: 'Philippine' };

/** Splits text into speakable chunks: short first chunk, sentences after, none over maxLength. */
export function splitForSpeech(text, { maxLength = 220, firstMaxLength = 120 } = {}) {
  const clean = String(text || '').replace(/[*_`#>]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  // Split only where punctuation is followed by a space, so "3.5" and "e.g.," stay intact.
  const sentences = clean.split(/(?<=[.!?。！？]["')\]]*)\s+/).map(part => part.trim()).filter(Boolean);
  const chunks = [];
  const pushBounded = (sentence, limit) => {
    let rest = sentence;
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' — '));
      const at = cut > limit * 0.4 ? cut + 1 : Math.max(window.lastIndexOf(' '), Math.floor(limit * 0.6));
      chunks.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim();
    }
    if (rest) chunks.push(rest);
  };
  for (const sentence of sentences) {
    const limit = chunks.length ? maxLength : firstMaxLength;
    const last = chunks.at(-1);
    // Join very short fragments ("OK.", "Yes!") with the next sentence when it fits.
    if (last && chunks.length > 1 && last.length < 25 && last.length + sentence.length + 1 <= maxLength) chunks[chunks.length - 1] = `${last} ${sentence}`;
    else pushBounded(sentence, limit);
  }
  return chunks;
}

/** Resolves the device's voices, waiting briefly for them to load. */
export function listPhoneVoices({ speechSynthesisImpl = globalThis.speechSynthesis, lang = 'en', timeoutMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!speechSynthesisImpl?.getVoices) return Promise.resolve([]);
  const read = () => speechSynthesisImpl.getVoices().filter(voice => !lang || String(voice.lang || '').replace('_', '-').toLowerCase().startsWith(lang.toLowerCase()));
  const now = read();
  if (now.length) return Promise.resolve(now);
  return new Promise(resolve => {
    let timer = null;
    const done = () => { clearTimer(timer); speechSynthesisImpl.removeEventListener?.('voiceschanged', done); resolve(read()); };
    speechSynthesisImpl.addEventListener?.('voiceschanged', done);
    timer = setTimer(done, timeoutMs);
  });
}

/** A short, human label such as "Samantha (US)" or "British English". */
export function labelVoice(voice) {
  const lang = String(voice?.lang || '').replace('_', '-');
  const region = REGION_NAMES[lang.split('-')[1]?.toUpperCase()] || lang;
  const name = String(voice?.name || '').replace(/^(Google|Microsoft|Apple)\s+/i, '').replace(/\s*[-–(]\s*(English|United States|United Kingdom).*$/i, '').trim();
  if (!name || /^english\b/i.test(name)) return `${region} English`;
  return `${name} (${region})`;
}

/** Chooses up to `count` distinct, good-sounding English voices from what the device offers. */
export function pickVoiceOptions(voices, count = 5) {
  const score = voice => {
    const lang = String(voice.lang || '').replace('_', '-');
    const locale = LOCALE_ORDER.indexOf(lang);
    return (voice.localService ? 40 : 0) + (QUALITY.test(voice.name) ? 30 : 0) + (voice.default ? 5 : 0) + (locale >= 0 ? 20 - locale : 0);
  };
  const ranked = [...(voices || [])].filter(voice => voice?.voiceURI).sort((a, b) => score(b) - score(a));
  const chosen = [], labels = new Set(), locales = new Map();
  // First pass favors variety across accents; second pass fills remaining slots.
  for (const pass of [1, 2]) {
    for (const voice of ranked) {
      if (chosen.length >= count) break;
      const label = labelVoice(voice), locale = String(voice.lang);
      if (labels.has(label) || chosen.includes(voice)) continue;
      if (pass === 1 && (locales.get(locale) || 0) >= 2) continue;
      chosen.push(voice); labels.add(label); locales.set(locale, (locales.get(locale) || 0) + 1);
    }
  }
  return chosen.map(voice => ({ id: voice.voiceURI, label: labelVoice(voice), name: voice.name, lang: voice.lang, offline: Boolean(voice.localService) }));
}

/** Playback adapter for createConversationAgent backed by speechSynthesis. */
export function createPhoneVoicePlayback({ speechSynthesisImpl = globalThis.speechSynthesis,
  UtteranceImpl = globalThis.SpeechSynthesisUtterance, voiceId = null, rate = 1, pitch = 1, lang = 'en-US',
  startTimeoutMs = 4000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let job = null, settings = { voiceId, rate: bounded(rate), pitch: bounded(pitch) };
  function bounded(value) { return Math.max(0.5, Math.min(2, Number(value) || 1)); }
  const findVoice = () => settings.voiceId ? speechSynthesisImpl?.getVoices?.().find(voice => voice.voiceURI === settings.voiceId) || null : null;
  const valid = item => job === item && !item.signal?.aborted;

  function clearQueue(item) {
    clearTimer(item.watchdog); item.watchdog = null;
    for (const utterance of item.queued) utterance.onstart = utterance.onend = utterance.onerror = null;
    item.queued = [];
    try { speechSynthesisImpl.cancel(); } catch {}
  }
  function finish(item, error) {
    if (!valid(item)) return;
    clearQueue(item); job = null;
    item.signal?.removeEventListener?.('abort', item.cancel);
    if (error) item.onError?.(error);
    else { item.onChunkEnd?.({ completedChunks: item.chunks.length, chunkIndex: item.chunks.length - 1 }); item.onEnd?.(); }
    item.resolve();
  }
  function blocked(item, reason, message) {
    if (!valid(item)) return;
    clearQueue(item); item.playing = false;
    item.onBlocked?.(message, { reason });
  }
  function speakFrom(item, index) {
    if (!valid(item)) return;
    clearQueue(item);
    const voice = findVoice();
    item.watchdog = setTimer(() => blocked(item, 'stalled', 'The phone voice did not start. Tap Play to try again.'), Math.max(1000, startTimeoutMs));
    for (let i = index; i < item.chunks.length; i++) {
      const utterance = new UtteranceImpl(item.chunks[i]);
      if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else utterance.lang = lang;
      utterance.rate = settings.rate; utterance.pitch = settings.pitch;
      utterance.onstart = () => {
        if (!valid(item)) return;
        clearTimer(item.watchdog); item.watchdog = null; item.current = i;
        if (!item.playing) { item.playing = true; item.onStart?.(); }
        item.onProgress?.({ currentChunk: i, completedChunks: i, chunkCount: item.chunks.length, playing: true });
      };
      utterance.onend = () => {
        if (!valid(item)) return;
        item.completed = Math.max(item.completed, i + 1);
        if (i === item.chunks.length - 1) finish(item);
        else item.onProgress?.({ currentChunk: i + 1, completedChunks: item.completed, chunkCount: item.chunks.length, playing: true });
      };
      utterance.onerror = event => {
        if (!valid(item)) return;
        const code = event?.error;
        if (code === 'interrupted' || code === 'canceled') return;
        if (code === 'not-allowed') blocked(item, 'permission', 'Tap Play to hear the reply.');
        else finish(item, new Error(code === 'voice-unavailable' || code === 'language-unavailable' ? 'The selected phone voice is unavailable. Choose another voice.' : 'The phone voice could not play this reply.'));
      };
      item.queued.push(utterance);
      speechSynthesisImpl.speak(utterance);
    }
  }
  function stop() {
    const old = job; job = null;
    if (!old) return;
    clearQueue(old); old.signal?.removeEventListener?.('abort', old.cancel); old.resolve();
  }
  return {
    play(options) {
      stop();
      if (options?.signal?.aborted) return Promise.resolve();
      if (!speechSynthesisImpl?.speak || typeof UtteranceImpl !== 'function') { options?.onError?.(new Error('This device has no text-to-speech voice. The reply is shown as text.')); return Promise.resolve(); }
      const chunks = splitForSpeech(options?.content);
      if (!chunks.length) { options?.onEnd?.(); return Promise.resolve(); }
      return new Promise(resolve => {
        const item = { ...options, resolve, chunks, queued: [], watchdog: null, current: 0, completed: 0, playing: false };
        item.cancel = () => { if (job === item) stop(); };
        job = item;
        item.signal?.addEventListener?.('abort', item.cancel, { once: true });
        item.onPreparing?.({ chunkIndex: 0, chunkCount: chunks.length });
        speakFrom(item, 0);
      });
    },
    resume() { if (job) speakFrom(job, job.completed); },
    stop, destroy: stop,
    state: () => job ? { currentChunk: job.current, completedChunks: job.completed, chunkCount: job.chunks.length, playing: job.playing } : {},
    setVoice(id) { settings = { ...settings, voiceId: typeof id === 'string' && id ? id : null }; },
    setRate(value) { settings = { ...settings, rate: bounded(value) }; },
    setPitch(value) { settings = { ...settings, pitch: bounded(value) }; },
    settings: () => ({ ...settings }),
    /** Speaks a short sample with a voice, outside any conversation turn. */
    preview(id = settings.voiceId, text = 'Hi! This is how I will sound when I reply.') {
      stop();
      if (!speechSynthesisImpl?.speak || typeof UtteranceImpl !== 'function') return false;
      try { speechSynthesisImpl.cancel(); } catch {}
      const utterance = new UtteranceImpl(text);
      const voice = id ? speechSynthesisImpl.getVoices?.().find(item => item.voiceURI === id) : null;
      if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else utterance.lang = lang;
      utterance.rate = settings.rate; utterance.pitch = settings.pitch;
      speechSynthesisImpl.speak(utterance);
      return true;
    },
  };
}
