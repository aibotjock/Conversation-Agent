# On-device listening and phone voices

Version 0.2.0 adds a free voice path with no speech API: the microphone is understood on the device with sherpa-onnx, and replies are spoken with the device's own voices. The original cloud path (`createBrowserAudioInput` + the host's OpenAI transcription adapter) is unchanged and still available.

## What changed and why

| Problem | Cause in 0.1.x | 0.2.0 |
| --- | --- | --- |
| Microphone too sensitive | Loudness-only detection with a low trigger; any cough, knock or TV could start a turn or cancel a reply | Silero voice detection, **and** a turn only starts once real words are recognized. Noise without words never starts a turn or interrupts a reply |
| Delay after speaking | Waited 1.1 s of silence, then uploaded the clip for cloud transcription | Ends the turn after 0.7 s of silence (adjustable); words are already recognized while you speak, so text is ready immediately |
| No feedback while talking | Captions only after transcription | Live captions while you speak (`onPartial`) |
| Reply waits for audio | Spoken audio prepared server-side | Phone voice starts with the first sentence |
| Self-interruption | Device speaker picked up by the mic | While a reply plays, at least three recognized words are needed, and words matching the reply being spoken are ignored |

## Setup

1. Download the speech files (about 60 MB) into a folder your app serves:

   ```bash
   npm run fetch:sherpa -- public/sherpa
   ```

   This fetches the sherpa-onnx WebAssembly runtime (published as `sherpa_onnx_web` on pub.dev), Silero VAD, and the streaming English Zipformer (int8), then writes `manifest.json` with Subresource Integrity hashes. To use a runtime you built yourself with sherpa-onnx's `build-wasm-simd-web.sh`, add `--runtime-dir=PATH`.

2. Wire it up:

   ```js
   import { createConversationAgent, createSherpaAudioInput, createPhoneVoicePlayback, mountVoiceCircle, mountVoiceSettings } from '@aibotjock/conversation-agent';

   const input = createSherpaAudioInput({ assetBaseUrl: '/sherpa/' });
   const playback = createPhoneVoicePlayback();
   const agent = createConversationAgent({ input, playback, host });
   mountVoiceCircle({ container: circleElement, agent });
   mountVoiceSettings({ container: settingsElement, playback, input, selectedVoiceId: saved.voiceId, sensitivity: saved.sensitivity, onChange: save });
   input.preload(); // optional: start the one-time download when the page opens
   ```

   The host no longer needs `transcribe` for this path; utterances arrive as text.

The page must be served over HTTPS (or localhost). The listening worker is `src/sherpa-speech-worker.js`; it loads the runtime with `importScripts`, so a strict Content-Security-Policy needs `worker-src 'self'` and `script-src` / `connect-src` allowing the asset folder, plus `'wasm-unsafe-eval'` for WebAssembly.

Models are stored in the browser's Cache Storage (`conversation-agent-sherpa-v1`) after the first download.

## Tuning

- `sensitivity`: `'low'` (noisy rooms, Silero threshold 0.65), `'normal'` (0.5), `'high'` (quiet voices, 0.35). Changeable live with `input.setSensitivity()` or the settings panel.
- `pauseMs`: silence that ends a turn, 300–2000 ms, default 700. Lower is snappier; higher suits people who pause mid-thought.

## Voices

`mountVoiceSettings` lists up to five English voices the device offers, preferring offline and higher-quality voices and a mix of accents, each with a Preview button. On Android Chrome the list usually shows one voice per English accent (US, British, Australian, Indian…); the specific voice for each accent is set in Android's text-to-speech settings. Voices marked "uses internet" are provided by the operating system over the network.

## Measured results

Real-model checks (`npm run test:sherpa`) run the unchanged worker script against the Node build of the same sherpa-onnx runtime (1.13.8) on one 2.1 GHz server core:

- 8.9 s of audio (with silence) was processed in about 1.0 s, roughly 9× faster than real time, with partial captions during speech and the correct final transcript.
- Four seconds of background noise with loud knocks produced no turn, caption or interruption.
- A reply's own words played back into the microphone were discarded as echo; different speech during a reply interrupted it.
- Late frames from a stopped microphone session produced no turn.

Phones are slower than this server core, but the headroom is large. Physical Android testing is still required (see limits).

Natural neural voices were also measured in the same runtime. In a browser, without native threads, Kokoro needed about 2.3 s of computing per second of speech and Supertonic about 1 s, so they would add delay on phones. They are a better fit for a future native Android app.

## Limits

- Not yet verified on a physical phone: download time, battery, echo with a loudspeaker, Bluetooth and headset routing, and recognition of accents or soft speech.
- The English model is trained on read audiobooks (LibriSpeech). Expect occasional misheard words, especially names and technical terms.
- The phone-voice playback reports completed sentences as progress; the host should still treat unacknowledged replies as unplayed.
- Downloads total about 60 MB once per device (cached afterwards).

## Licensing note for a paid app

This is not legal advice; please have the licenses reviewed before a store release.

- sherpa-onnx is Apache-2.0, Silero VAD is MIT and the Zipformer model is Apache-2.0. Keep their notices.
- The published sherpa-onnx WebAssembly runtime is a full build that also contains its text-to-speech components, which link espeak-ng (GPL-3.0). This package does not use those components, but they are inside the distributed `.wasm`. For a closed-source paid app, consider building a listening-only runtime (sherpa-onnx with TTS disabled) and passing it with `--runtime-dir`.
- Phone voices come from the operating system and are not distributed by the app.
