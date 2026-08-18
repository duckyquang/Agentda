# ADR 0004: voice notes transcribe locally by default, hosted only on request

Status: accepted, 2026-08-18

## Context

PRD Q1 asked where Telegram voice notes get transcribed: a local Whisper-class model, or a
hosted speech API. Voice matters here beyond convenience — an approval card can be answered
by voice ("yes", "approve but cc anna"), so the transcriber sits directly on the path that
decides whether a consequential action runs.

## Decision

**Local by default, hosted behind explicit opt-in, and never a silent fallback between
them.**

Three things decide it:

1. **A voice note is the user's actual voice.** Everything else Agentda runs stays on the
   user's machine under their own login; shipping a default that uploads recordings of
   them to a vendor would contradict the one promise the whole design is built on.
2. **The transcript can approve an action.** A hosted transcriber would put a third party
   on the approval path. Local keeps the decision loop on one machine.
3. **Cost.** Hosted transcription is metered, and voice is the one input a user produces
   casually and at length.

So `voice = "local"` (the default) runs `whisper.cpp` on the machine, and `voice = "openai"`
sends the audio to OpenAI's transcription endpoint for people who would rather not install
anything. `voice = "off"` refuses voice notes with a message saying so.

**No silent fallback.** If local transcription is configured and the binary or model is
missing, the bot says exactly what is missing and stops. It does not quietly route the
recording to a hosted API instead — a privacy default that degrades without telling you is
not a default.

## Mechanics

Telegram delivers voice notes as OGG/Opus. `getFile` gives a path, the file comes down over
HTTPS, and `whisper.cpp` wants 16 kHz mono WAV — so the local path needs `ffmpeg` too. Both
are one `brew install` away and neither ships with Agentda: downloading a multi-gigabyte
model on someone's behalf is not a thing an install script should do.

    brew install ffmpeg whisper-cpp
    curl -L -o ~/.agentda/models/ggml-base.en.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

`AGENTDA_WHISPER_BIN` and `AGENTDA_WHISPER_MODEL` override the lookup.

The transcript is shown in the thread as the message that was sent, before the bot acts on
it — the user has to be able to see what was heard, especially when what was heard was
"yes". A transcript that answers an open approval card answers it exactly like typed text
does, through the same parser (FR-21), so there is one place where "yes" becomes a decision.

## Consequences

- Voice needs two binaries the user installs themselves, and the quickstart says so.
- Whisper's accuracy on short utterances is the weak point, and short utterances are
  exactly what approval answers are. The transcript is therefore always echoed before it
  takes effect, and anything the parser is not sure about is treated as an ordinary
  message rather than a decision.
- The hosted path exists mainly so "I don't want to install anything" has an answer. It is
  metered and off-machine, and the config field is the only way to turn it on.

## Status of verification

The pipeline is exercised by unit tests over a stub transcriber (download → convert →
transcribe → route). Neither `ffmpeg` nor `whisper.cpp` is installed on the development
machine, so the local backend has **not** been run end to end against real audio, and the
hosted backend has not been run against a real key. Both are listed in
[USER_REQUEST.md](../../USER_REQUEST.md).
