import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVoiceCircle } from '../src/voice-circle.js';

class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.value = '';
    this._text = '';
    this.hidden = false;
    this.disabled = false;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Dynamic HTML must not be used.'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  addEventListener(type, callback) {
    const values = this.listeners.get(type) || new Set();
    values.add(callback);
    this.listeners.set(type, values);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatch(type) {
    const event = { preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false };
    if (this.disabled && type === 'click') return event;
    for (const callback of this.listeners.get(type) || []) callback(event);
    return event;
  }
}

function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }
function byTag(container, tag) { return descendants(container).find(node => node.tagName === tag.toUpperCase()); }
function byText(container, text) { return descendants(container).find(node => node.tagName === 'BUTTON' && node.textContent === text); }
function setup(overrides = {}, options = {}) {
  const calls = [];
  const initial = { phase: 'idle', active: false, inputState: 'off', outputState: 'idle' };
  const agent = {
    state: () => initial,
    active: () => initial.active,
    start: value => calls.push(['start', value]),
    stop: () => calls.push(['stop']),
    interrupt: () => calls.push(['interrupt']),
    toggleMute: () => calls.push(['mute']),
    playAudio: () => calls.push(['play']),
    sendText: value => calls.push(['send', value]),
    ...overrides,
  };
  const documentImpl = { createElement: tag => new Element(tag) };
  const container = new Element('main');
  const view = mountVoiceCircle({ container, agent, documentImpl, ...options });
  return { calls, agent, container, view };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('circle uses native accessible buttons and host-owned start and stop options', () => {
  const { container, calls, view } = setup({}, { getStartOptions: () => ({ conversationId: 'private-host-conversation' }) });
  assert.equal(view.button.tagName, 'BUTTON');
  assert.equal(view.button.type, 'button');
  assert.equal(view.button.getAttribute('aria-label'), 'Start conversation');
  assert.equal(view.button.getAttribute('aria-pressed'), 'false');
  assert.equal(view.button.listeners.has('keydown'), false, 'Native button keyboard activation must remain intact.');
  view.button.dispatch('click');
  assert.deepEqual(calls, [['start', { conversationId: 'private-host-conversation' }]]);
  view.update({ phase: 'listening', active: true, inputState: 'listening', outputState: 'idle' });
  assert.equal(view.button.getAttribute('aria-label'), 'Stop conversation');
  assert.equal(view.button.getAttribute('aria-pressed'), 'true');
  view.button.dispatch('click');
  assert.deepEqual(calls.at(-1), ['stop']);
  assert.equal(descendants(container).some(node => node.getAttribute('role') === 'status' && node.getAttribute('aria-live') === 'polite'), true);
  const defaultView = setup();
  defaultView.view.button.dispatch('click');
  assert.deepEqual(defaultView.calls[0], ['start', {}], 'Reusable circle must not inject a demo conversation ID.');
});

test('circle preserves separate honest channels, safe captions, and optional actions', () => {
  const { container, calls, view } = setup();
  view.update({ phase: 'reviewing', active: true, muted: true, audioBlocked: true, inputState: 'muted', outputState: 'checking', userCaption: '<img src=x onerror=alert(1)>', assistantCaption: '<script>evil()</script>', message: 'Checking before playback.', warning: '<b>Not ready</b>' });
  const nodes = descendants(container);
  assert.equal(nodes.some(node => node.tagName === 'IMG' || node.tagName === 'SCRIPT'), false);
  assert.equal(nodes.some(node => node.textContent === '<img src=x onerror=alert(1)>'), true);
  assert.equal(nodes.some(node => node.textContent === '<script>evil()</script>'), true);
  assert.equal(nodes.some(node => node.textContent === 'Microphone muted · Checking reply'), true);
  assert.equal(nodes.some(node => node.textContent === 'Checking the reply' && node.getAttribute('role') === 'status'), true);
  assert.equal(nodes.some(node => node.textContent === '<b>Not ready</b>' && node.getAttribute('role') === 'alert'), true);
  const mute = byText(container, 'Unmute microphone');
  assert.equal(mute.getAttribute('aria-pressed'), 'true');
  mute.dispatch('click');
  byText(container, 'Interrupt reply').dispatch('click');
  const play = byText(container, 'Play prepared audio');
  assert.equal(play.hidden, false);
  play.dispatch('click');
  assert.deepEqual(calls, [['mute'], ['interrupt'], ['play']]);
  view.update({ phase: 'listening', active: true, audioBlocked: false });
  assert.equal(play.hidden, true);
  assert.equal(nodes.find(node => node.getAttribute('role') === 'alert').hidden, true);
});

test('circle distinguishes stalled and permission-blocked audio with recovery before captions', () => {
  const { container, calls, view } = setup({ interrupt: undefined, toggleMute: undefined, sendText: undefined }, { showComposer: false });
  const nodes = descendants(container), replay = byText(container, 'Play prepared audio');
  assert.equal(replay.hidden, true);
  assert.ok(nodes.indexOf(replay) < nodes.findIndex(node => node.className === 'voice-captions'), 'Recovery stays beside the circle, before long captions.');
  for (const [reason, label] of [['stalled', 'Audio stalled'], ['permission', 'Audio needs permission'], ['paused', 'Audio paused'], [null, 'Audio paused']]) {
    view.update({ phase: 'paused', active: true, inputState: 'monitoring', outputState: 'blocked', audioBlocked: true, audioBlockReason: reason });
    assert.equal(nodes.some(node => node.getAttribute('role') === 'status' && node.textContent === label), true);
    assert.equal(nodes.some(node => node.textContent === `Microphone on · ${label}`), true);
    assert.equal(replay.hidden, false); assert.equal(replay.disabled, false);
  }
  replay.dispatch('click'); assert.deepEqual(calls, [['play']]);
  view.update({ phase: 'speaking', active: true, inputState: 'monitoring', outputState: 'playing', audioBlocked: false, audioBlockReason: null });
  assert.equal(replay.hidden, true);
});

test('typed fallback submits once, retains a failed draft, and handles action errors', async () => {
  let rejectSend;
  let attempt = 0;
  const { container, calls, view } = setup({
    sendText: text => { calls.push(['send', text]); attempt += 1; return attempt === 1 ? new Promise((_, reject) => { rejectSend = reject; }) : undefined; },
    start: () => { throw new Error('Host secret detail'); },
  });
  const textarea = byTag(container, 'textarea');
  const form = byTag(container, 'form');
  const send = byText(container, 'Send message');
  assert.equal(textarea.getAttribute('aria-label'), 'Type a message');
  textarea.value = '  My study preference  ';
  assert.equal(form.dispatch('submit').defaultPrevented, true);
  form.dispatch('submit');
  assert.deepEqual(calls, [['send', 'My study preference']]);
  assert.equal(send.disabled, true);
  rejectSend(new Error('Private internal message'));
  await flush();
  assert.equal(send.disabled, false);
  assert.equal(textarea.value, '  My study preference  ');
  assert.equal(container.textContent.includes('Private internal message'), false);
  form.dispatch('submit');
  await flush();
  assert.equal(textarea.value, '');
  view.button.dispatch('click');
  assert.equal(container.textContent.includes('That action could not finish.'), true);
  assert.equal(container.textContent.includes('Host secret detail'), false);
});

test('destroy detaches every action and suppresses late updates without stopping a shared agent', async () => {
  let rejectStart;
  const { container, calls, view } = setup({ start: () => new Promise((_, reject) => { rejectStart = reject; }) });
  const button = view.button;
  const form = byTag(container, 'form');
  const textarea = byTag(container, 'textarea');
  button.dispatch('click');
  view.destroy();
  view.destroy();
  assert.equal(container.children.length, 0);
  button.dispatch('click');
  textarea.value = 'Do not send';
  form.dispatch('submit');
  view.update({ active: true, warning: 'Late state' });
  rejectStart(new Error('Late error'));
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(container.children.length, 0);
  assert.equal(button.getAttribute('aria-label'), 'Start conversation');
  const minimal = setup({ interrupt: undefined, toggleMute: undefined, playAudio: undefined, sendText: undefined }, { showComposer: false });
  assert.equal(descendants(minimal.container).filter(node => node.tagName === 'BUTTON').length, 1);
  assert.equal(byTag(minimal.container, 'form'), undefined);
});

test('circle works with strict style CSP and labels microphone pauses honestly', () => {
  const { container, view } = setup({}, { reducedMotion: true });
  const nodes = descendants(container);
  assert.equal(nodes.some(node => node.tagName === 'STYLE'), false);
  assert.equal(nodes.some(node => node.getAttribute('style') !== null), false);
  assert.equal(view.element.getAttribute('data-reduced-motion'), 'true');
  view.update({ phase: 'paused', active: true, muted: true, inputState: 'off', outputState: 'idle' });
  assert.equal(nodes.some(node => node.getAttribute('role') === 'status' && node.textContent === 'Microphone muted'), true);
  assert.equal(nodes.some(node => node.textContent === 'Microphone muted · Ready'), true);
  assert.equal(view.element.getAttribute('data-input-state'), 'off');
  assert.equal(view.element.getAttribute('data-output-state'), 'idle');
  view.update({ phase: 'paused', active: true, inputState: 'unavailable', outputState: 'idle' });
  assert.equal(nodes.some(node => node.getAttribute('role') === 'status' && node.textContent === 'Microphone unavailable'), true);
  view.update({ phase: 'paused', active: true, audioBlocked: true, inputState: 'monitoring', outputState: 'blocked' });
  assert.equal(nodes.some(node => node.getAttribute('role') === 'status' && node.textContent === 'Audio paused'), true);
  const noNotice = setup({}, { showNotice: false });
  noNotice.view.update({ phase: 'idle', message: 'Host supplies its own notice.' });
  assert.equal(descendants(noNotice.container).find(node => node.textContent === 'Host supplies its own notice.').hidden, true);
});

test('local mock demo completes start, synthetic turn, manual play, interruption and stop without network', async () => {
  const original = { document: globalThis.document, window: globalThis.window, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, fetch: globalThis.fetch };
  const container = new Element('main');
  const controls = new Map(['demo-notice', 'lifecycle', 'mock-turn', 'mock-interrupt', 'browser-speech', 'manual-play', 'voice-circle'].map(name => [name, new Element(name === 'voice-circle' ? 'div' : 'button')]));
  for (const control of controls.values()) container.appendChild(control);
  controls.get('manual-play').checked = true;
  const mock = new Element('input'); mock.value = 'mock'; mock.checked = true;
  const microphone = new Element('input'); microphone.value = 'microphone'; microphone.checked = false;
  const documentImpl = new Element('document');
  documentImpl.hidden = false;
  documentImpl.createElement = tag => new Element(tag);
  documentImpl.getElementById = name => controls.get(name);
  documentImpl.querySelectorAll = () => [mock, microphone];
  let clock = 0;
  let timerId = 0;
  let networkCalls = 0;
  const timers = new Map();
  const advance = async milliseconds => {
    const destination = clock + milliseconds;
    while (true) {
      const due = [...timers.entries()].filter(([, item]) => item.at <= destination).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
      for (let count = 0; count < 12; count++) await Promise.resolve();
    }
    clock = destination;
    for (let count = 0; count < 12; count++) await Promise.resolve();
  };
  const state = () => JSON.parse(controls.get('lifecycle').textContent);
  try {
    globalThis.document = documentImpl;
    globalThis.window = new Element('window');
    globalThis.setTimeout = (callback, delay = 0) => { const key = ++timerId; timers.set(key, { callback, at: clock + delay }); return key; };
    globalThis.clearTimeout = key => timers.delete(key);
    globalThis.fetch = () => { networkCalls++; throw new Error('Mock demo must never fetch a provider.'); };
    await import('../demo/demo.js');
    const circle = controls.get('voice-circle');
    const orb = byText(circle, 'Start conversationVoice or text') || descendants(circle).find(node => node.className === 'voice-orb');
    orb.dispatch('click');
    await advance(100);
    assert.equal(state().active, true);
    assert.equal(mock.disabled, true, 'Input mode stays stable during an active session.');
    controls.get('mock-turn').dispatch('click');
    await advance(1200);
    assert.equal(state().playback, 'blocked');
    assert.equal(circle.textContent.includes('[Synthetic spoken turn:'), true);
    assert.equal(circle.textContent.includes('mock conversation with fixed replies'), true);
    byText(circle, 'Play prepared audio').dispatch('click');
    assert.equal(state().playback, 'playing');
    assert.equal(controls.get('demo-notice').textContent.includes('no sound is playing'), true);
    controls.get('mock-interrupt').dispatch('click');
    await advance(5000);
    assert.equal(state().playback, 'idle', 'Cancelled simulation must never resume or complete a stale turn.');
    orb.dispatch('click');
    await advance(0);
    assert.equal(state().active, false);
    assert.equal(state().microphone, 'off');
    assert.equal(mock.disabled, false);
    assert.equal(networkCalls, 0);
    assert.equal(timers.size, 0);
  } finally {
    Object.assign(globalThis, original);
  }
});

test('accepted typed turns allow interruption during blocked playback and ignore stale submission completion', async () => {
  const resolvers = [];
  const { container, calls, view } = setup({ sendText: text => { calls.push(['send', text]); return new Promise(resolve => resolvers.push(resolve)); } });
  const form = byTag(container, 'form');
  const textarea = byTag(container, 'textarea');
  const send = byText(container, 'Send message');
  textarea.value = 'First turn';
  form.dispatch('submit');
  view.update({ active: true, phase: 'thinking', userCaption: 'First turn', outputState: 'generating' });
  assert.equal(textarea.value, '');
  assert.equal(send.disabled, false);
  view.update({ active: true, phase: 'paused', userCaption: 'First turn', outputState: 'blocked', audioBlocked: true });
  textarea.value = 'Interrupt with a typed turn';
  form.dispatch('submit');
  assert.equal(send.disabled, true);
  resolvers[0]({ content: 'Old reply' });
  await flush();
  assert.equal(send.disabled, true, 'Old completion cannot unlock a newer unaccepted submission.');
  assert.equal(textarea.value, 'Interrupt with a typed turn');
  view.update({ active: true, phase: 'thinking', userCaption: 'Interrupt with a typed turn', outputState: 'generating' });
  assert.equal(send.disabled, false);
  assert.equal(textarea.value, '');
  assert.deepEqual(calls, [['send', 'First turn'], ['send', 'Interrupt with a typed turn']]);
  textarea.value = 'Keep this next draft';
  resolvers[1](null);
  await flush();
  assert.equal(textarea.value, 'Keep this next draft');
});
