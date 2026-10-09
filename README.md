# Conversation-Agent

Reusable foreground voice conversation for browser applications. StudyChat is the first host integration. This project uses an original circle interface and documented APIs; it does not copy ChatGPT assets or connect to private ChatGPT services.

## Boundaries

The package manages capture, bounded microphone pre-roll, local turn detection, interruption, cancellation, captions and conversation state. The host manages authentication, transcription services, knowledge, response approval, persistent records and accounting. No medical knowledge or permanent credentials belong in the browser core.

The initial StudyChat transport uploads a bounded WAV utterance after local turn completion. Microphone monitoring remains active during output, but this is not continuous cloud transcription and partial cloud captions are not promised. Speech is generated only after the existing independent whole-reply grounding review. Browser echo cancellation is best effort; physical Android speaker and Bluetooth checks must establish compatibility.

## Public interface

`createConversationAgent` accepts `input`, `host`, `playback`, `onState` and optional clock/timer controls. The controller exposes start, stop, interrupt, toggleMute, sendText, playAudio, clearCaptions, active, state and destroy. State includes independent input/output fields and a turn revision; an output operation may run while microphone input is active.

`createBrowserAudioInput` provides bounded local PCM capture, WAV utterances and speech events. It exposes start, stop, setMuted, setOutputActive and capability checks. A permission or device failure must retain the host's typed/manual alternative.

`conversation-voice-circle` provides the original visual state component. Hosts bind its actions to the controller and supply captions and essential controls. Use the external stylesheet when the host disallows inline styles.

### Host adapter

- `openSession` / `closeSession` authorize and terminate the host audio session when supplied.
- `transcribe` receives audio, MIME type, duration, utterance identity, conversation identity and an abort signal, and returns final text.
- `sendTurn` receives text, conversation identity, turn identity and an abort signal. It returns a server-released message identity and eligible spoken text.
- `recordPlayback`, when supplied, reports conservative completed-segment boundaries. Playback reports are not proof of hearing.

The playback adapter implements play, stop and resume. It must stop immediately on cancellation and reject stale callbacks. Paid audio requests use authorized server message IDs, not arbitrary browser text or client approval flags.

## StudyChat integration

The application adapter lives in StudyChat; it connects this package to its existing `/api/chat` and approved-message speech service. Source freshness, source-span hashes, whole-reply review, imports, replay protections, question banks and spaced repetition stay in StudyChat. Marin is the default; Cedar, Coral, Sage and Ash remain available there.

StudyChat checks out a versioned, hash-recorded runtime artifact through `scripts/sync-conversation-agent.mjs`. Do not edit generated files in its vendor directory. Edit this repository, validate affected behavior, generate the runtime artifact and record the source revision. This avoids maintaining separate handwritten implementations.

## Privacy and operating limits

- Capture is foreground-only and explicit. End, mute, navigation, logout and backgrounding must release microphone tracks.
- Audio pre-roll is memory-only. No raw-audio file storage or model-training feature is enabled.
- Only authenticated server services access provider credentials. There are no broad provider tokens in the component.
- Hosts enforce authorization, idempotency, duration/request limits and costs; cancellation does not imply zero provider charges.
- OpenAI is the initial provider. Claude is on hold. Astra is prohibited for development, inference, review, tests, selection and fallback.
- Optional persistent learner memory needs host consent, inspection, correction, deletion and account/workspace isolation. The core has no persistent learner database.

## Compatibility and evidence

First target: foreground Android Chrome over HTTPS. Native applications, embedded browsers, background operation, Bluetooth routing and other browsers need explicit platform validation. Unsupported cases retain manual or typed recovery; do not represent them as certified hands-free operation.

Run `npm test` for the new package checks. A standalone mock-host demo will exercise reuse without credentials. Validation status, device limitations and release measurements belong in `docs/VALIDATION_STATUS.md`; targets must not be described as measured results. Repeat passing checks only when changed behavior or a documented failure justifies it.

## Rights and distribution

All rights reserved pending the owner's license selection. Public GitHub visibility does not itself grant an open-source license. Use original design assets and preserve dependency notices. Do not use OpenAI/ChatGPT marks as product branding or claim affiliation. Authorized AI voices remain subject to provider terms and must be disclosed as AI-generated.

Implementation evidence is being assembled. No perfect accuracy, universal compatibility or physical-phone latency claim is made by this document.
