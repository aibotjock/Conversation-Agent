import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneVoicePlayback, labelVoice, listPhoneVoices, pickVoiceOptions, splitForSpeech } from '../src/phone-voice.js';
import { mountVoiceSettings } from '../src/voice-settings.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fakeSpeech(voices = []) {
  const spoken = [], timers = new Map(); let timerId = 0;
  const synth = { spoken, cancels: 0, listeners: new Map(),
    getVoices: () => voices, speak(utterance) { spoken.push(utterance); }, cancel() { this.cancels++; },
    addEventListener(type, fn) { this.listeners.set(type, fn); }, removeEventListener(type) { this.listeners.delete(type); } };
  class Utterance { constructor(text) { this.text = text; } }
  const setTimer = (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; };
  const clearTimer = id => timers.delete(id);
  return { synth, Utterance, timers, setTimer, clearTimer };
}

const voice = (name, lang, extra = {}) => ({ name, lang, voiceURI: `${name}|${lang}`, localService: true, ...extra });

test('replies split into a short first chunk and whole sentences without breaking numbers', () => {
  const chunks = splitForSpeech('Yes. The value is 3.5 percent, e.g., in most cells. **Next**, we look at ATP! Why? Because it matters.');
  assert.equal(chunks[0], 'Yes.');
  assert.ok(chunks.some(chunk => chunk.includes('3.5 percent, e.g., in most cells.')));
  assert.ok(chunks.every(chunk => !chunk.includes('*')));
  const long = splitForSpeech(`${'word '.repeat(80)}end.`);
  assert.ok(long.every(chunk => chunk.length <= 220)); assert.ok(long[0].length <= 120);
  assert.deepEqual(splitForSpeech('   '), []);
});

test('speech starts with the first sentence and reports progress through the whole reply', async () => {
  const s = fakeSpeech([voice('Samantha', 'en-US')]);
  const playback = createPhoneVoicePlayback({ speechSynthesisImpl: s.synth, UtteranceImpl: s.Utterance, setTimer: s.setTimer, clearTimer: s.clearTimer, voiceId: 'Samantha|en-US', rate: 1.2 });
  const events = [];
  const done = playback.play({ content: 'First sentence. The second sentence is a bit longer than that. The third sentence closes the reply.', signal: new AbortController().signal,
    onPreparing: value => events.push(['preparing', value.chunkCount]), onStart: () => events.push(['start']),
    onProgress: value => events.push(['progress', value.completedChunks]), onChunkEnd: value => events.push(['chunkEnd', value.completedChunks]),
    onEnd: () => events.push(['end']), onError: error => events.push(['error', error.message]) });
  assert.equal(s.synth.spoken.length, 3, 'all sentences queued at once for seamless speech');
  assert.equal(s.synth.spoken[0].voice.name, 'Samantha'); assert.equal(s.synth.spoken[0].rate, 1.2);
  for (const utterance of [...s.synth.spoken]) { utterance.onstart(); utterance.onend(); }
  await done;
  assert.deepEqual(events.map(event => event[0]), ['preparing', 'start', 'progress', 'progress', 'progress', 'progress', 'progress', 'chunkEnd', 'end']);
  assert.deepEqual(events.at(-2), ['chunkEnd', 3]);
});

test('interrupting cancels speech immediately and late callbacks are ignored', async () => {
  const s = fakeSpeech();
  const playback = createPhoneVoicePlayback({ speechSynthesisImpl: s.synth, UtteranceImpl: s.Utterance, setTimer: s.setTimer, clearTimer: s.clearTimer });
  const controller = new AbortController(); let ended = 0;
  const done = playback.play({ content: 'One. Two.', signal: controller.signal, onEnd: () => ended++ });
  const first = s.synth.spoken[0]; first.onstart?.();
  const cancels = s.synth.cancels;
  controller.abort(); await done;
  assert.ok(s.synth.cancels > cancels); assert.equal(first.onend, null);
  assert.equal(ended, 0); assert.deepEqual(playback.state(), {});
});

test('blocked or stalled speech asks for a tap and resumes from the unfinished sentence', async () => {
  const s = fakeSpeech();
  const playback = createPhoneVoicePlayback({ speechSynthesisImpl: s.synth, UtteranceImpl: s.Utterance, setTimer: s.setTimer, clearTimer: s.clearTimer });
  const blocked = [];
  void playback.play({ content: 'One. The second sentence is long enough. The third sentence is long enough too.', signal: new AbortController().signal, onBlocked: (message, detail) => blocked.push(detail.reason) });
  s.synth.spoken[0].onstart(); s.synth.spoken[0].onend();
  s.synth.spoken[1].onerror({ error: 'not-allowed' });
  assert.deepEqual(blocked, ['permission']);
  playback.resume();
  assert.deepEqual(s.synth.spoken.slice(-2).map(item => item.text), ['The second sentence is long enough.', 'The third sentence is long enough too.']);
  const watchdog = [...s.timers.values()].at(-1); watchdog.fn();
  assert.deepEqual(blocked, ['permission', 'stalled']);
  playback.stop();
});

test('a missing speech engine or voice reports an error instead of hanging', async () => {
  const errors = [];
  await createPhoneVoicePlayback({ speechSynthesisImpl: null }).play({ content: 'Hi.', onError: error => errors.push(error.message) });
  const s = fakeSpeech();
  const playback = createPhoneVoicePlayback({ speechSynthesisImpl: s.synth, UtteranceImpl: s.Utterance, setTimer: s.setTimer, clearTimer: s.clearTimer });
  const done = playback.play({ content: 'Hi.', onError: error => errors.push(error.message) });
  s.synth.spoken[0].onerror({ error: 'voice-unavailable' }); await done;
  assert.match(errors[0], /no text-to-speech/); assert.match(errors[1], /Choose another voice/);
});

test('five distinct English voices are picked, favoring offline and higher-quality voices', async () => {
  const voices = [
    voice('Google US English', 'en-US', { localService: false }), voice('Samantha', 'en-US'), voice('Alex', 'en-US'), voice('Ava (Enhanced)', 'en-US'),
    voice('Daniel', 'en-GB'), voice('Karen', 'en-AU'), voice('Moira', 'en-IE'), voice('Rishi', 'en-IN'), voice('Thomas', 'fr-FR'),
    { name: 'No id', lang: 'en-US' },
  ];
  const options = pickVoiceOptions(voices, 5);
  assert.equal(options.length, 5);
  assert.equal(options[0].label, 'Ava (Enhanced) (US)');
  assert.equal(new Set(options.map(option => option.label)).size, 5);
  assert.ok(options.every(option => option.offline));
  assert.ok(options.filter(option => option.lang === 'en-US').length <= 2, 'accent variety first');
  assert.equal(labelVoice({ name: 'English United Kingdom', lang: 'en_GB' }), 'British English');
  const s = fakeSpeech([]);
  const pending = listPhoneVoices({ speechSynthesisImpl: s.synth, setTimer: s.setTimer, clearTimer: s.clearTimer });
  s.synth.getVoices = () => voices; s.synth.listeners.get('voiceschanged')();
  assert.equal((await pending).length, 9);
});

class FakeElement {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.listeners = new Map(); this._text = ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
  dispatch(type) { for (const fn of this.listeners.get(type) || []) fn({}); }
}
const all = element => [element, ...element.children.flatMap(all)];

test('voice settings show five previewable voices, keep a saved choice and set mic sensitivity', async () => {
  const documentImpl = { createElement: tag => new FakeElement(tag) };
  const root = new FakeElement('div');
  const voices = ['Ava', 'Samantha', 'Daniel', 'Karen', 'Moira', 'Rishi'].map((name, index) => voice(name, ['en-US', 'en-US', 'en-GB', 'en-AU', 'en-IE', 'en-IN'][index]));
  const chosen = [], previews = [], sensitivity = [], changes = [];
  const playback = { setVoice: id => chosen.push(id), preview: id => previews.push(id) };
  const input = { setSensitivity: value => sensitivity.push(value) };
  const settings = mountVoiceSettings({ container: root, documentImpl, playback, input,
    listVoices: async () => voices, selectedVoiceId: 'Karen|en-AU', onChange: value => changes.push(value) });
  await settings.ready;
  const list = all(root).find(element => element.className === 'voice-settings-list');
  const radios = all(list).filter(element => element.type === 'radio');
  assert.equal(radios.length, 5); assert.equal(chosen.at(-1), 'Karen|en-AU');
  assert.equal(radios.find(radio => radio.checked).value, 'Karen|en-AU');
  const previewButtons = all(list).filter(element => element.className === 'voice-settings-preview');
  assert.equal(previewButtons.length, 5); assert.match(previewButtons[0].attributes.get('aria-label'), /^Preview /);
  previewButtons[1].dispatch('click'); assert.deepEqual(previews, [radios[1].value]);
  radios[0].checked = true; radios[0].dispatch('change');
  assert.equal(changes.at(-1).voiceId, radios[0].value); assert.equal(radios.filter(radio => radio.checked).length, 1);
  const low = all(root).find(element => element.type === 'radio' && element.value === 'low'); low.checked = true; low.dispatch('change');
  assert.deepEqual(sensitivity, ['normal', 'low']); assert.equal(changes.at(-1).sensitivity, 'low');
  assert.match(all(root).find(element => element.className === 'voice-settings-note').textContent, /without a download/);
  settings.destroy(); assert.equal(root.children.length, 0);
});

test('a device with fewer voices says so, and a saved voice that disappeared falls back', async () => {
  const documentImpl = { createElement: tag => new FakeElement(tag) };
  const root = new FakeElement('div'); const chosen = [];
  const settings = mountVoiceSettings({ container: root, documentImpl, playback: { setVoice: id => chosen.push(id), preview() {} },
    listVoices: async () => [voice('Only', 'en-US')], selectedVoiceId: 'Gone|en-US' });
  await settings.ready;
  assert.equal(chosen.at(-1), 'Only|en-US');
  assert.match(all(root).find(element => element.className === 'voice-settings-note').textContent, /offers 1 English voice\./);
  settings.destroy();
});
