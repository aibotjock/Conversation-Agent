import test from 'node:test';
import assert from 'node:assert/strict';
import { createSherpaAudioInput, createStreamResampler, loadSherpaManifest } from '../src/sherpa-input.js';
import { wrapClassicApi } from '../scripts/fetch-sherpa-assets.mjs';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('streaming resampler keeps phase across frames and matches a one-shot conversion', () => {
  const resample = createStreamResampler(48000, 16000);
  const ramp = Float32Array.from({ length: 48000 }, (_, i) => i / 48000);
  const pieces = [];
  for (let i = 0; i < ramp.length; i += 128 * 3 + 1) pieces.push(...resample(ramp.slice(i, i + 128 * 3 + 1)));
  assert.ok(Math.abs(pieces.length - 16000) <= 1);
  for (let i = 1; i < pieces.length; i++) assert.ok(Math.abs(pieces[i] - pieces[i - 1] - 3 / 48000) < 1e-5, `smooth at ${i}`);
  const same = createStreamResampler(16000, 16000)(new Float32Array([0.1, 0.2]));
  assert.deepEqual(Array.from(same, value => Math.round(value * 10) / 10), [0.1, 0.2]);
  assert.throws(() => createStreamResampler(4000), /sample rate/);
});

test('manifest paths resolve against the asset folder and keep integrity hashes', async () => {
  const files = Object.fromEntries(['glue', 'vadApi', 'asrApi', 'vad', 'encoder', 'decoder', 'joiner', 'tokens'].map(key => [key, { path: `${key === 'glue' || key.endsWith('Api') ? 'runtime' : 'models'}/${key}.bin`, integrity: `sha384-${key}` }]));
  const fetchImpl = async url => { assert.equal(url, 'https://app.test/static/sherpa/manifest.json'); return { ok: true, json: async () => ({ version: '1.13.8', files }) }; };
  const manifest = await loadSherpaManifest('https://app.test/static/sherpa', fetchImpl);
  assert.equal(manifest.runtime.glue, 'https://app.test/static/sherpa/runtime/glue.bin');
  assert.equal(manifest.runtime.wasmBase, 'https://app.test/static/sherpa/runtime/');
  assert.deepEqual(manifest.models.encoder, { url: 'https://app.test/static/sherpa/models/encoder.bin', integrity: 'sha384-encoder' });
  await assert.rejects(loadSherpaManifest('https://app.test/x/', async () => ({ ok: false })), /asset script/);
  delete files.tokens;
  await assert.rejects(loadSherpaManifest('https://app.test/x/', async () => ({ ok: true, json: async () => ({ files }) })), /tokens/);
});

test('wrapped sherpa API files are isolated, so their helpers cannot collide', () => {
  const scope = {};
  const one = wrapClassicApi('function freeConfig() { return "vad"; }\nfunction createVad() { return freeConfig(); }\nif (typeof process == "object") module.exports = {};', 'VadApi', ['createVad']);
  const two = wrapClassicApi('function freeConfig() { return "asr"; }\nfunction createOnlineRecognizer() { return freeConfig(); }', 'AsrApi', ['createOnlineRecognizer']);
  new Function('self', one)(scope); new Function('self', two)(scope);
  assert.equal(scope.VadApi.createVad(), 'vad'); assert.equal(scope.AsrApi.createOnlineRecognizer(), 'asr');
  assert.throws(() => wrapClassicApi('function other() {}', 'X', ['createVad']), /does not define createVad/);
  assert.throws(() => wrapClassicApi('', 'bad name', ['x']), /Invalid/);
});

function fixture({ permission, loadError = null } = {}) {
  const workers = [], tracks = [], contexts = [], progress = [];
  class FakeWorker {
    constructor(url) { this.url = String(url); this.sent = []; this.listeners = new Map(); this.terminated = false; workers.push(this); }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    postMessage(message) {
      this.sent.push(message);
      if (message.type === 'init') queueMicrotask(() => {
        this.emit({ type: 'progress', files: { encoder: { bytes: 50, total: 100 } } });
        this.emit(loadError ? { type: 'error', message: loadError } : { type: 'ready' });
      });
    }
    emit(data) { for (const handler of [...(this.listeners.get('message') || [])]) handler({ data }); }
    terminate() { this.terminated = true; }
  }
  const node = () => ({ connect() {}, disconnect() {} });
  const processors = [];
  class Context {
    constructor() { this.sampleRate = 48000; this.destination = {}; contexts.push(this); }
    resume() { return Promise.resolve(); } close() { this.closed = true; return Promise.resolve(); }
    createMediaStreamSource() { return node(); } createGain() { return { ...node(), gain: { value: 1 } }; }
    createScriptProcessor() { const processor = node(); processors.push(processor); return processor; }
  }
  const handlers = new Map();
  const documentImpl = { hidden: false, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  const navigatorImpl = { mediaDevices: { getUserMedia: async () => {
    if (permission) throw Object.assign(new Error('denied'), { name: permission });
    const track = { stopped: 0, stop() { this.stopped++; }, getSettings: () => ({ echoCancellation: true }) }; tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  } } };
  const manifest = { runtime: { glue: 'g', vad: 'v', asr: 'a', wasmBase: 'b' }, models: {} };
  const input = createSherpaAudioInput({ manifest, windowImpl: { isSecureContext: true }, navigatorImpl, documentImpl,
    AudioContextImpl: Context, WorkerImpl: FakeWorker, workerUrl: 'worker.js', onLoadProgress: value => progress.push(value) });
  const events = { states: [], starts: 0, partials: [], utterances: [], warnings: [] };
  const callbacks = { onState: value => events.states.push(value.phase), onSpeechStart: () => events.starts++, onPartial: text => events.partials.push(text),
    onUtterance: value => events.utterances.push(value), onWarning: value => events.warnings.push(value) };
  return { input, callbacks, events, workers, tracks, contexts, processors, progress, handlers, documentImpl };
}

test('microphone audio reaches the worker at 16 kHz and final text arrives as an utterance', async () => {
  const f = fixture();
  await f.input.start(f.callbacks);
  const worker = f.workers[0];
  assert.equal(worker.sent[0].type, 'init');
  assert.equal(f.progress.at(-1).phase, 'ready');
  assert.deepEqual(f.events.states.slice(-1), ['monitoring']);
  const session = worker.sent.filter(message => message.type === 'reset').at(-1).session;
  f.processors[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.2) } });
  const audio = worker.sent.find(message => message.type === 'audio');
  assert.equal(audio.session, session); assert.ok(Math.abs(audio.samples.length - 2048 / 3) <= 1);
  worker.emit({ type: 'speech-start', session }); worker.emit({ type: 'partial', session, text: 'Hello' });
  worker.emit({ type: 'final', session, text: 'Hello there', durationMs: 900, utteranceId: 'local-1' });
  assert.equal(f.events.starts, 1); assert.deepEqual(f.events.partials, ['Hello']);
  assert.deepEqual(f.events.utterances[0], { text: 'Hello there', durationMs: 900, utteranceId: 'local-1', mimeType: 'text/plain', audio: null });
  f.input.destroy();
  assert.equal(worker.terminated, true); assert.equal(f.tracks[0].stopped, 1);
});

test('stale worker events after stop, mute or restart are ignored', async () => {
  const f = fixture();
  await f.input.start(f.callbacks);
  const worker = f.workers[0];
  const first = worker.sent.filter(message => message.type === 'reset').at(-1).session;
  f.input.stop();
  worker.emit({ type: 'final', session: first, text: 'Late', utteranceId: 'x' });
  await f.input.start(f.callbacks);
  worker.emit({ type: 'final', session: first, text: 'Late again', utteranceId: 'y' });
  assert.equal(f.events.utterances.length, 0);
  assert.equal(f.workers.length, 1, 'models load once per page');
  f.input.setMuted(true);
  const current = worker.sent.filter(message => message.type === 'reset').at(-1).session;
  worker.emit({ type: 'speech-start', session: current });
  assert.equal(f.events.starts, 0);
  f.input.destroy();
});

test('output state, own-voice text and sensitivity are forwarded to the worker', async () => {
  const f = fixture();
  f.input.setSensitivity('low');
  await f.input.start(f.callbacks);
  const worker = f.workers[0];
  assert.equal(worker.sent[0].settings.sensitivity, 'low');
  f.input.setOutputText('Here is your answer.'); f.input.setOutputActive(true);
  assert.deepEqual(worker.sent.at(-2), { type: 'output', active: false, text: 'Here is your answer.' });
  assert.deepEqual(worker.sent.at(-1), { type: 'output', active: true });
  f.input.setSensitivity('high'); assert.equal(worker.sent.at(-1).settings.sensitivity, 'high');
  f.input.setSensitivity('loud'); assert.equal(worker.sent.at(-1).settings.sensitivity, 'high');
  assert.equal(f.input.state().sensitivity, 'high');
  f.input.destroy();
});

test('model download failures and denied permission become readable messages and can be retried', async () => {
  const failed = fixture({ loadError: 'Could not download the encoder speech model (404).' });
  await assert.rejects(failed.input.start(failed.callbacks), /encoder speech model/);
  assert.equal(failed.workers[0].terminated, true); assert.equal(failed.tracks[0].stopped, 1);
  await assert.rejects(failed.input.start(failed.callbacks), /encoder/); assert.equal(failed.workers.length, 2, 'retry starts fresh');
  const denied = fixture({ permission: 'NotAllowedError' });
  await assert.rejects(denied.input.start(denied.callbacks), /permission was denied/);
});

test('a hidden page releases the microphone', async () => {
  const f = fixture();
  await f.input.start(f.callbacks);
  f.documentImpl.hidden = true; f.handlers.get('visibilitychange')();
  assert.equal(f.tracks[0].stopped, 1); assert.equal(f.input.state().active, false);
  f.input.destroy(); await flush();
});
