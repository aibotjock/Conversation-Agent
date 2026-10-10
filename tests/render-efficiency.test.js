import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVoiceCircle } from '../src/voice-circle.js';
test('timer-only updates leave captions and accessibility attributes unchanged', () => {
  let writes = 0;
  class Element {
    constructor() { this.children = []; this.attributes = new Map(); this.text = ''; }
    set textContent(value) { writes++; this.text = value; }
    get textContent() { return this.text; }
    setAttribute(key, value) { writes++; this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key); }
    appendChild(child) { this.children.push(child); }
    addEventListener() {} removeEventListener() {} remove() {}
  }
  const state = { active: true, inputState: 'monitoring', outputState: 'generating', phase: 'thinking', userCaption: 'Hello', assistantCaption: 'Saved reply' };
  const circle = mountVoiceCircle({ container: new Element(), documentImpl: { createElement: () => new Element() }, agent: { start() {}, stop() {}, state: () => state } });
  const before = writes;
  circle.update({ ...state, replyWaitMs: 1000 });
  circle.update({ ...state, replyWaitMs: 2000 });
  assert.equal(writes, before);
  circle.update({ ...state, assistantCaption: 'New reply' });
  assert.equal(writes, before + 1);
  circle.destroy();
});
