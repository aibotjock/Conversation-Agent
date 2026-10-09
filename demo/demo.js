import { createConversationAgent, createBrowserAudioInput, mountVoiceCircle } from '../index.js';

const byId = id => document.getElementById(id);
const notice = byId('demo-notice');
const lifecycle = byId('lifecycle');
const mockTurnButton = byId('mock-turn');
const mockInterruptButton = byId('mock-interrupt');
const speechOption = byId('browser-speech');
const manualPlayOption = byId('manual-play');
const modeOptions = [...document.querySelectorAll('input[name="input-mode"]')];
const selectedMode = () => modeOptions.find(option => option.checked)?.value || 'mock';
const mockTranscription = '[Mock transcript: microphone audio captured; spoken words were not recognized.]';
let circle;
let nextId = 0;
const id = prefix => `${prefix}-${++nextId}`;
const aborted = () => new DOMException('Demo operation cancelled.', 'AbortError');

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(aborted()); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function createSyntheticInput() {
  let callbacks = null;
  let muted = false;
  let timer = null;
  return {
    start(value) { callbacks = value; muted = false; callbacks.onState?.({ phase: 'monitoring' }); },
    stop() { clearTimeout(timer); timer = null; callbacks = null; },
    setMuted(value) { muted = value; callbacks?.onState?.({ phase: muted ? 'off' : 'monitoring' }); },
    setOutputActive() {},
    trigger({ interruptionOnly = false } = {}) {
      if (!callbacks || muted) return;
      clearTimeout(timer);
      const captured = callbacks;
      captured.onSpeechStart?.();
      if (interruptionOnly) { captured.onState?.({ phase: 'monitoring' }); return; }
      timer = setTimeout(() => {
        if (callbacks !== captured || muted) return;
        captured.onState?.({ phase: 'monitoring' });
        captured.onUtterance?.({ audio: { mockText: '[Synthetic spoken turn: hello, I prefer short conversations.]' }, mimeType: 'application/x-demo', durationMs: 500, utteranceId: id('mock-utterance') });
      }, 180);
    },
  };
}

const syntheticInput = createSyntheticInput();
let realInput = null;
let currentInput = null;
let inputMode = 'mock';
const input = {
  start(callbacks) {
    inputMode = selectedMode();
    if (inputMode === 'microphone') {
      realInput ||= createBrowserAudioInput();
      currentInput = realInput;
      callbacks.onWarning?.('Mock transcription cannot recognize spoken words. Audio stays in this page.');
    } else currentInput = syntheticInput;
    return currentInput.start(callbacks);
  },
  stop() { currentInput?.stop(); currentInput = null; },
  setMuted(value) { currentInput?.setMuted?.(value); },
  setOutputActive(value) { currentInput?.setOutputActive?.(value); },
  destroy() { syntheticInput.stop(); realInput?.destroy?.(); },
};

function createMockPlayback() {
  let job = null;
  let mode = 'silent';
  let detail = 'Silent playback simulation. The reply is visible; no sound is playing.';
  const stop = () => {
    const old = job;
    job = null;
    if (!old) return;
    clearTimeout(old.timer);
    old.signal?.removeEventListener('abort', old.cancel);
    if (old.utterance) {
      old.utterance.onstart = old.utterance.onend = old.utterance.onerror = null;
      globalThis.speechSynthesis?.cancel();
    }
    old.resolve();
  };
  const valid = item => job === item && !item.signal?.aborted;
  function finish(item, error) {
    if (!valid(item)) return;
    clearTimeout(item.timer);
    item.signal?.removeEventListener('abort', item.cancel);
    job = null;
    if (error) item.onError?.(error);
    else {
      item.onProgress?.({ completedChunks: 1, currentChunk: 0 });
      item.onChunkEnd?.({ completedChunks: 1, chunkIndex: 0 });
      item.onEnd?.();
    }
    item.resolve();
  }
  function launch(item) {
    if (!valid(item) || item.started) return;
    item.started = true;
    const localVoice = speechOption.checked && globalThis.speechSynthesis?.getVoices().find(voice => voice.localService === true);
    if (localVoice && typeof globalThis.SpeechSynthesisUtterance === 'function') {
      mode = 'browser-speech';
      detail = 'Fixed demo text is playing with a browser-reported local voice. This is not the production speech provider.';
      const utterance = new SpeechSynthesisUtterance(item.content);
      item.utterance = utterance;
      utterance.voice = localVoice;
      utterance.onstart = () => { if (valid(item)) item.onStart?.(); };
      utterance.onend = () => finish(item);
      utterance.onerror = () => finish(item, new Error('The local browser voice could not play. Disable browser speech to use the silent demo.'));
      item.timer = setTimeout(() => finish(item, new Error('The local browser voice did not finish. Use the silent demo instead.')), 30000);
      try { globalThis.speechSynthesis.speak(utterance); }
      catch { finish(item, new Error('Browser speech is unavailable. Disable it to use the silent demo.')); }
      return;
    }
    mode = 'silent';
    detail = speechOption.checked
      ? 'No browser-reported local voice is available. Silent playback is being simulated; no sound is playing.'
      : 'Silent playback simulation. The reply is visible; no sound is playing.';
    item.onStart?.();
    item.timer = setTimeout(() => finish(item), 4500);
  }
  return {
    get mode() { return mode; },
    get detail() { return detail; },
    play(options) {
      stop();
      if (options.signal?.aborted) return Promise.resolve();
      return new Promise(resolve => {
        const item = { ...options, resolve, started: false, timer: null };
        item.cancel = () => { if (job === item) stop(); };
        job = item;
        item.signal?.addEventListener('abort', item.cancel, { once: true });
        item.onPreparing?.({ chunkIndex: 0, chunkCount: 1 });
        if (manualPlayOption.checked) item.onBlocked?.('Demo pause: tap Play reply to begin this prepared reply.');
        else item.timer = setTimeout(() => launch(item), 200);
      });
    },
    resume() { if (job) launch(job); },
    stop,
    destroy: stop,
  };
}

const playback = createMockPlayback();
let replyNumber = 0;
const replies = [
  'Hello. This is a mock conversation with fixed replies. Tell me what you would like the interface to do next.',
  'Thanks for trying the demo. You can type a message, mute the microphone, or interrupt this prepared reply.',
  'This reply demonstrates turn taking. The demo does not answer study questions or recognize spoken words.',
];
const host = {
  async startSession({ conversationId, signal }) {
    await wait(60, signal);
    return { conversationId: conversationId || 'mock-conversation', sessionId: id('mock-session') };
  },
  async transcribe({ audio, signal }) {
    await wait(250, signal);
    return { text: typeof audio?.mockText === 'string' ? audio.mockText : mockTranscription };
  },
  async sendTurn({ conversationId, signal }) {
    await wait(500, signal);
    const content = replies[replyNumber++ % replies.length];
    return { conversationId: conversationId || 'mock-conversation', messageId: id('mock-message'), content, spokenText: content, readoutAllowed: true };
  },
  cancel() {}, endSession() {}, reportPlayback() {},
};

function renderState(state) {
  let displayState = state;
  if (state.outputState === 'playing' && playback.mode === 'silent') {
    displayState = { ...state, message: playback.detail };
  }
  circle?.update(displayState);
  for (const option of modeOptions) option.disabled = state.active;
  mockTurnButton.disabled = !state.active || state.muted || inputMode !== 'mock';
  mockInterruptButton.disabled = !state.active || state.muted || inputMode !== 'mock';
  notice.textContent = state.outputState === 'playing' ? playback.detail
    : state.outputState === 'blocked' ? 'Playback is paused by the demo setting. Use Play reply in the circle to continue.'
    : inputMode === 'microphone' && state.active ? 'Real microphone input; mock transcription only. Audio remains in this page, and no words are inferred.'
    : 'Local mock mode. Synthetic turns and fixed replies do not invoke an AI model. Silent playback is the default.';
  lifecycle.textContent = JSON.stringify({ active: state.active, phase: state.phase, microphone: state.inputState, playback: state.outputState, setupPending: state.setupPending, muted: state.muted, sessionEpoch: state.sessionEpoch, turnEpoch: state.turnEpoch, replyWaitMs: Math.round(state.replyWaitMs || 0) }, null, 2);
}

const agent = createConversationAgent({ input, host, playback, onState: renderState });
circle = mountVoiceCircle({ container: byId('voice-circle'), agent, getStartOptions: () => ({ conversationId: 'mock-conversation' }) });
renderState(agent.state());
mockTurnButton.addEventListener('click', () => syntheticInput.trigger());
mockInterruptButton.addEventListener('click', () => syntheticInput.trigger({ interruptionOnly: true }));
for (const option of modeOptions) option.addEventListener('change', () => {
  inputMode = selectedMode();
  renderState(agent.state());
});
speechOption.addEventListener('change', () => {
  if (agent.state().outputState === 'playing' || agent.state().outputState === 'preparing') agent.interrupt();
  renderState(agent.state());
});
