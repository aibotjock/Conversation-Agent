# Conversation-Agent validation status

The dedicated public GitHub repository is `aibotjock/Conversation-Agent`. StudyChat integrates its generated artifact on `feature/conversation-agent`; private-test deployment must use that branch. GitHub publication, artifact `sourceRevision`, deployed revision and physical device results are separate records. No npm registry publication has occurred. Store publication remains on hold.

## Completed package checks

**28 unique groups passed:** 12 conversation-core, 9 browser-audio and 7 circle/demo groups. These use injected adapters, synthetic PCM, fake browser resources and a mock host; they make no paid provider requests.

Coverage includes pre-roll and hesitation, bounded capture, PCM16 WAV, optional reference correlation, AudioWorklet/ScriptProcessor lifecycle, microphone permission/disconnection/mute/background/offline cleanup, no automatic online restart, duplicate utterance IDs, stale requests/callbacks, active cancellation IDs, conservative playback checkpoints, bounded checkpoint failure recovery, typed fallback, accessible controls, strict style CSP and the credential-free demo.

The first core/audio run passed 17 of 18 groups. The failed brief-impulse/capture-limit case exposed a discarded impulse incorrectly locking capture; it was fixed and only that failed group was repeated. A circle channel group was repeated after wording changed. Later disconnect, strict-CSP, typed interruption and demo cases were novel checks. Unchanged passed groups were not broadly repeated.

## StudyChat integration evidence

| Scope | Recorded result |
| --- | --- |
| New host backend mocks | 14 groups passed |
| Approved speech server/player scopes | 37 new or affected groups passed |
| Existing speech-player Node EventTarget/Audio mocks affected by the change | 3 groups passed |
| Conservative voice-history guards | 4 groups passed |
| Actual StudyChat host/adapter through authenticated local routes, mocked providers | 3 groups passed first run; 7 synthetic provider dispatches |
| New browser integration QA | **0/9 executed; blocked** by missing Chromium and empty/invalid installer downloads |

These counts are supplied by their implementation owners. They do not represent physical-phone trials, new live provider calls, or a complete application-suite rerun. The 3 adapter groups exercised the shipped host callback and real authenticated local routes with synthetic provider responses, covering session/transcription/readout/checkpoint binding, active cancellation and late-result suppression, and bounded checkpoint failure recovery. StudyChat records tested hashes in `qa/conversation-agent-integration-results.json`. The Chromium installation failure is an environment blocker, not nine application-test failures. StudyChat's existing validation ledger retains earlier live checks and historical failures.

## Limits and remaining acceptance

- Completed WAV utterances are transcribed through OpenAI. Continuous cloud transcription and partial provider captions are not implemented.
- Local detection uses requested browser echo cancellation, adaptive energy thresholds and optional supplied PCM correlation. StudyChat does not supply an actual player PCM reference. Speaker echo and brief backchannels may trigger interruption; acoustic separation is not certified.
- Approved MP3 can use MediaSource progressive playback or buffered recovery. Mocks establish state/cancellation behavior, not audible output, acoustic fidelity or a measured speedup.
- Physical Android Chrome microphone permission, soft initial syllables, real loudspeaker/headphone/Bluetooth interruption, media routing, foreground behavior and response timing remain unverified. Other platforms require their own acceptance.
- Playback checkpoints describe completed chunks, never proof that a person heard them. Missing acknowledgments remain conservative on the host.
- Persistent-memory consent/inspection/edit/delete UI and editable pronunciation remain future host features. Existing history/preferences and study scheduling remain host responsibilities.
- Whole-reply medical grounding and current-source authorization stay in StudyChat. Automated review is not clinician approval or an accuracy guarantee.

No Astra, Claude activation, store submission, or paid provider call is part of these package checks. Repeat a passing check only when a relevant change or failure supplies a reason; record that reason and limit the scope.


## Version 0.1.1 — audio recovery classification (October 10, 2026)

A new phone report exposed a StudyChat MP3 playback stall. The host player owns media transport; this package now accepts optional `onBlocked(message, {reason})` metadata and keeps bounded `audioBlockReason` values (`permission`, `stalled`, `paused`, or null). Unknown legacy blocks no longer assert a permission failure. Recovery is available before captions as **Play prepared audio** when the host supplies `playAudio`. Obsolete recovery state is cleared on start, resume, playback, replacement, failure, interruption and shutdown. No source approval or business logic moved into this package.

Seven unique focused groups passed: three new regressions and four affected checks. The first command matched six groups: `node --test --test-name-pattern='blocked audio resumes|playback block reasons|circle preserves separate|circle distinguishes stalled|circle works with strict style|local mock demo completes' tests/conversation-core.test.js tests/voice-circle.test.js`. The second ran only the new failure path: `node --test --test-name-pattern='a failed replacement clears' tests/conversation-core.test.js`. These checks use injected state/DOM mocks; they are not physical-browser or phone results. The retest reason is changed recovery state and button semantics. Capture, server helpers and unchanged checks were not rerun. Paid calls: zero. `git diff --check` passed. StudyChat must sync this published revision and provide the existing circle's `playAudio` action; phone audibility, autoplay, echo rejection and Bluetooth remain unverified.


## Version 0.2.0 — on-device listening and phone voices (October 11, 2026)

**Package suite: 50 groups passed** (`npm test`), including 18 new groups: on-device input (resampling, manifest, isolated runtime API files, worker messaging, stale-session suppression, output/echo forwarding, download and permission failures, background release), phone-voice playback (sentence splitting, progress, interruption, blocked/stalled recovery, missing engine/voice, voice selection, settings panel) and controller handling of text utterances and live captions. The existing demo test was updated for the new settings container and still makes no network request.

**Real-model groups: 4 passed** (`npm run test:sherpa`), running `src/sherpa-speech-worker.js` unchanged against sherpa-onnx 1.13.8 (Node WebAssembly build) with Silero VAD and `sherpa-onnx-streaming-zipformer-en-20M-2023-02-17` (int8) on one 2.1 GHz server core: correct transcript of a bundled 6.6 s recording, about 1.0 s to process 8.9 s of audio, no turn from 4 s of noise with knocks, own-reply echo discarded while different speech interrupts, and late frames from a stopped session ignored. The first run failed two groups: the recognizer configuration requested a BPE vocabulary (fixed; the worker now also rejects null model handles), and the first spoken words were dropped until a short silent lead-in was added before each utterance. Expectations were then aligned with the recording's reference transcript.

**Asset script:** run end to end with a stand-in local runtime (`--runtime-dir`); model downloads, extraction, API wrapping and manifest integrity hashes were produced (56.8 MB). The pub.dev runtime download branch could not be exercised from the build environment.

**Not yet verified:** the browser WebAssembly runtime in a real browser, physical Android microphone/speaker behavior, phone-voice audibility and voice lists on devices, download time and battery use. Neural voices (Kokoro, Supertonic, KittenTTS) were benchmarked in the same runtime and not adopted because they ran at or below real time on a server core.
