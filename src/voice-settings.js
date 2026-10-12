import { listPhoneVoices, pickVoiceOptions } from './phone-voice.js';

const SENSITIVITY_LABELS = { low: 'Low — noisy rooms', normal: 'Normal', high: 'High — quiet voices' };

/** Voice and microphone settings: five reply voices with previews, plus mic sensitivity.
 * The host stores the chosen values (onChange) and passes them back on the next visit.
 */
export function mountVoiceSettings({ container, playback, input = null, documentImpl = globalThis.document,
  speechSynthesisImpl = globalThis.speechSynthesis, count = 5, selectedVoiceId = null, sensitivity = 'normal',
  onChange = () => {}, listVoices = () => listPhoneVoices({ speechSynthesisImpl }),
} = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('A DOM container is required.');
  if (!playback || typeof playback.setVoice !== 'function') throw new TypeError('A phone-voice playback is required.');
  let destroyed = false, options = [], voiceId = selectedVoiceId, radios = [];
  const listeners = [];
  const make = (tag, className, text) => {
    const element = documentImpl.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const listen = (element, type, handler) => { element.addEventListener(type, handler); listeners.push(() => element.removeEventListener(type, handler)); };
  const name = `voice-${Math.random().toString(36).slice(2, 8)}`;

  const wrapper = make('section', 'conversation-voice-settings');
  wrapper.setAttribute('aria-label', 'Voice settings');
  const voiceSet = make('fieldset', 'voice-settings-group');
  voiceSet.appendChild(make('legend', '', 'Reply voice'));
  const list = make('div', 'voice-settings-list');
  const status = make('p', 'voice-settings-note', 'Loading voices…');
  status.setAttribute('role', 'status');
  voiceSet.appendChild(list); voiceSet.appendChild(status);
  wrapper.appendChild(voiceSet);

  function choose(id, notify = true) {
    voiceId = id; playback.setVoice(id);
    for (const radio of radios) radio.checked = radio.value === id;
    if (notify) onChange({ voiceId: id, sensitivity });
  }

  function render() {
    list.textContent = ''; radios = [];
    if (!options.length) { status.textContent = 'No voices were found on this device. Replies will be shown as text.'; return; }
    for (const option of options) {
      const row = make('div', 'voice-settings-row');
      const label = make('label', 'voice-settings-choice');
      const radio = make('input');
      radio.type = 'radio'; radio.name = name; radio.value = option.id; radio.checked = option.id === voiceId;
      radios.push(radio);
      listen(radio, 'change', () => { if (radio.checked) choose(option.id); });
      label.appendChild(radio);
      label.appendChild(make('span', '', option.label));
      if (!option.offline) label.appendChild(make('small', 'voice-settings-tag', 'uses internet'));
      const preview = make('button', 'voice-settings-preview', 'Preview');
      preview.type = 'button';
      preview.setAttribute('aria-label', `Preview ${option.label}`);
      listen(preview, 'click', () => { playback.preview(option.id); });
      row.appendChild(label); row.appendChild(preview);
      list.appendChild(row);
    }
    status.textContent = options.length < count
      ? `This device offers ${options.length} English voice${options.length === 1 ? '' : 's'}. More can be installed in the phone's text-to-speech settings.`
      : 'Voices come from your device and work without a download.';
  }

  if (input && typeof input.setSensitivity === 'function') {
    const micSet = make('fieldset', 'voice-settings-group');
    micSet.appendChild(make('legend', '', 'Microphone sensitivity'));
    const row = make('div', 'voice-settings-segments');
    for (const value of ['low', 'normal', 'high']) {
      const label = make('label', 'voice-settings-choice');
      const radio = make('input');
      radio.type = 'radio'; radio.name = `${name}-mic`; radio.value = value; radio.checked = value === sensitivity;
      listen(radio, 'change', () => { if (!radio.checked) return; sensitivity = value; input.setSensitivity(value); onChange({ voiceId, sensitivity }); });
      label.appendChild(radio); label.appendChild(make('span', '', SENSITIVITY_LABELS[value]));
      row.appendChild(label);
    }
    micSet.appendChild(row);
    wrapper.appendChild(micSet);
    input.setSensitivity(sensitivity);
  }

  container.appendChild(wrapper);
  const loaded = Promise.resolve(listVoices()).then(voices => {
    if (destroyed) return;
    options = pickVoiceOptions(voices, count);
    // Keep a saved choice if the device still has it; otherwise start with the best voice.
    if (!options.some(option => option.id === voiceId)) voiceId = options[0]?.id || null;
    playback.setVoice(voiceId);
    render();
  }, () => { if (!destroyed) { options = []; render(); } });

  return { element: wrapper, ready: loaded, options: () => options.map(option => ({ ...option })),
    value: () => ({ voiceId, sensitivity }), select: id => { if (options.some(option => option.id === id)) choose(id, false); },
    destroy() { destroyed = true; for (const remove of listeners.splice(0)) remove(); wrapper.remove(); },
  };
}
