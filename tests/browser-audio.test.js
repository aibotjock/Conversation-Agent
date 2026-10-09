import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalVad, encodePcmWav, resampleMono, createBrowserAudioInput } from '../src/browser-audio.js';
const rate = 16000;
const frame = (amplitude, ms = 20) => new Float32Array(rate * ms / 1000).fill(amplitude);
function feed(vad, amplitude, ms) { for (let elapsed = 0; elapsed < ms; elapsed += 20) vad.process(frame(amplitude, Math.min(20, ms - elapsed))); }
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

test('local pre-roll preserves speech onset before detection and hesitant pauses stay in one utterance', () => {
  const utterances = []; let detected = 0;
  const vad = createLocalVad({ onSpeechStart: () => detected++, onUtterance: value => utterances.push(value) });
  feed(vad, 0, 300); feed(vad, 0.025, 40); assert.equal(detected, 0);
  feed(vad, 0.07, 300); assert.equal(detected, 1);
  feed(vad, 0, 600); assert.equal(utterances.length, 0); feed(vad, 0.07, 200); feed(vad, 0, 1120);
  assert.equal(utterances.length, 1); assert.equal(detected, 1);
  assert.ok(utterances[0].samples.some(value => Math.abs(value - 0.025) < 0.000001));
  assert.ok(utterances[0].durationMs < 60000); assert.equal(vad.state().active, false);
});

test('brief impulses are discarded and memory/capture limits require silence before another utterance', () => {
  const utterances = [], warnings = []; const vad = createLocalVad({ maxDurationMs: 1000, onUtterance: value => utterances.push(value), onWarning: value => warnings.push(value) });
  feed(vad, 0.1, 80); feed(vad, 0, 1120); assert.equal(utterances.length, 0);
  feed(vad, 0.1, 1600); assert.equal(utterances.length, 1); assert.ok(utterances[0].samples.length <= rate);
  assert.equal(vad.state().locked, true); assert.equal(warnings.length, 1);
  feed(vad, 0.1, 3000); assert.equal(utterances.length, 1); assert.ok(vad.state().bufferedSamples <= rate);
  feed(vad, 0, 1120); feed(vad, 0.1, 300); feed(vad, 0, 1120); assert.equal(utterances.length, 2);
  vad.reset(); assert.equal(vad.state().bufferedSamples, 0);
});

test('provided playback PCM is rejected as echo while independent overlapping speech can interrupt', () => {
  let starts = 0; const utterances = [];
  const vad = createLocalVad({ onSpeechStart: () => starts++, onUtterance: value => utterances.push(value) });
  const reference = frame(0.1); vad.setOutputActive(true); vad.setOutputReference(reference);
  for (let i = 0; i < 20; i++) vad.process(reference); assert.equal(starts, 0);
  const learner = frame(0.1); for (let i = 1; i < learner.length; i += 2) learner[i] = -0.1;
  for (let i = 0; i < 15; i++) vad.process(learner); assert.equal(starts, 1);
  feed(vad, 0, 1120); assert.equal(utterances.length, 1);
  // This tests correlation only, not certified loudspeaker/learner separation.
});

test('WAV encoding is bounded mono PCM16 with deterministic headers and sample values', async () => {
  const pcm = new Float32Array([-2, -1, 0, 1, 2, NaN]); const wav = encodePcmWav(pcm);
  const bytes = new Uint8Array(await wav.arrayBuffer()), view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF'); assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint32(24, true), 16000); assert.equal(view.getUint16(34, true), 16);
  assert.deepEqual(Array.from({ length: pcm.length }, (_, index) => view.getInt16(44 + index * 2, true)), [-32768, -32768, 0, 32767, 32767, 0]);
  assert.throws(() => encodePcmWav(new Float32Array(16000 * 60 + 1)), /60 seconds/);
  assert.throws(() => encodePcmWav(pcm, 44100), /supported-rate/);
  const resampled = resampleMono(new Float32Array(48000).fill(0.1), 48000); assert.equal(resampled.length, 16000); assert.ok(Math.abs(resampled[999] - 0.1) < 0.000001);
});

function browserFixture({ permission, worklet = false } = {}) {
  const tracks = [], contexts = [], processors = [], requests = [], events = new Map();
  const stream = () => { const track = { stops: 0, stop() { this.stops++; }, getSettings: () => ({ echoCancellation: true }) }; tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] }; };
  const node = () => ({ connect() {}, disconnect() {} });
  class Context {
    constructor() { this.sampleRate = 16000; this.destination = {}; this.closed = 0; contexts.push(this); if (worklet) this.audioWorklet = { addModule: async url => { this.moduleUrl = url; } }; }
    resume() { return Promise.resolve(); } close() { this.closed++; return Promise.resolve(); }
    createMediaStreamSource() { return node(); } createGain() { return { ...node(), gain: { value: 1 } }; }
    createScriptProcessor() { const processor = node(); processors.push(processor); return processor; }
  }
  class Worklet { constructor() { Object.assign(this, node()); this.port = { close() {} }; processors.push(this); } }
  const documentImpl = { hidden: false, addEventListener: (name, value) => events.set(name, value), removeEventListener: name => events.delete(name) };
  const windowImpl = { isSecureContext: true, AudioContext: Context, AudioWorkletNode: worklet ? Worklet : null, crypto: { randomUUID: () => 'uuid' } };
  const navigatorImpl = { mediaDevices: { getUserMedia: value => { requests.push(value); return permission ? permission(stream) : Promise.resolve(stream()); } } };
  const input = createBrowserAudioInput({ windowImpl, navigatorImpl, documentImpl });
  return { input, windowImpl, navigatorImpl, documentImpl, tracks, contexts, processors, requests, events, stream };
}

test('browser capture emits one WAV utterance and microphone mute closes tracks then reacquires once', async () => {
  const f = browserFixture(), utterances = [], phases = [];
  await f.input.start({ onUtterance: value => utterances.push(value), onState: value => phases.push(value.phase) });
  assert.equal(f.requests[0].audio.echoCancellation, true); assert.equal(f.requests[0].audio.channelCount, 1);
  const processor = f.processors[0];
  for (let i = 0; i < 20; i++) processor.onaudioprocess({ inputBuffer: { getChannelData: () => frame(0.08) } });
  for (let i = 0; i < 56; i++) processor.onaudioprocess({ inputBuffer: { getChannelData: () => frame(0) } });
  assert.equal(utterances.length, 1); assert.equal(utterances[0].audio.type, 'audio/wav'); assert.equal(utterances[0].utteranceId, 'uuid');
  f.input.setMuted(true); assert.equal(f.tracks[0].stops, 1); assert.equal(f.input.state().active, false); assert.equal(f.contexts[0].closed, 1);
  f.input.setMuted(false); await flush(); assert.equal(f.requests.length, 2); assert.equal(f.input.state().active, true);
  f.input.destroy(); assert.equal(f.tracks[1].stops, 1); assert.equal(f.events.size, 0); assert.ok(phases.includes('capturing'));
});

test('late microphone permission cannot capture after stop or background navigation', async () => {
  let resolve; const pending = new Promise(yes => { resolve = yes; }); const f = browserFixture({ permission: () => pending });
  const started = f.input.start({}); f.input.stop(); const stream = f.stream(); resolve(stream); await started;
  assert.ok(f.tracks[0].stops >= 1); assert.equal(f.input.state().active, false); assert.equal(f.processors.length, 0);
  f.input.destroy();
  const g = browserFixture(); await g.input.start({}); g.documentImpl.hidden = true; g.events.get('visibilitychange')();
  assert.equal(g.tracks[0].stops, 1); assert.equal(g.input.state().active, false); g.input.destroy();
});

test('AudioWorklet capture is self-hosted and its cancelled callbacks cannot emit utterances', async () => {
  const f = browserFixture({ worklet: true }); let utterances = 0;
  await f.input.start({ onUtterance: () => utterances++ });
  assert.match(f.contexts[0].moduleUrl, /\/src\/browser-audio\.js$/); assert.ok(!f.contexts[0].moduleUrl.startsWith('blob:'));
  const callback = f.processors[0].port.onmessage; f.input.stop();
  for (let i = 0; i < 100; i++) callback({ data: frame(0.1) }); assert.equal(utterances, 0); f.input.destroy();
});

test('unsupported capture and denied permission remain explicit failures without background retries', async () => {
  const f = browserFixture({ permission: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) });
  await assert.rejects(f.input.start({}), /permission was denied/); assert.equal(f.requests.length, 1); assert.equal(f.contexts[0].closed, 1);
  f.input.destroy();
  const unsupported = createBrowserAudioInput({ windowImpl: { isSecureContext: false }, navigatorImpl: {}, documentImpl: {} });
  await assert.rejects(unsupported.start({}), /HTTPS/); unsupported.destroy();
});

test('unexpected microphone disconnection releases capture and reports an actionable unavailable state', async () => {
  const f = browserFixture(), phases = [], warnings = [];
  await f.input.start({ onState: value => phases.push(value.phase), onWarning: value => warnings.push(value) });
  f.tracks[0].onended();
  assert.equal(f.input.state().active, false); assert.equal(f.tracks[0].stops, 1);
  assert.equal(phases.at(-1), 'unavailable'); assert.match(warnings.at(-1), /disconnected.*typing/);
  assert.equal(f.requests.length, 1); f.input.destroy();
});
