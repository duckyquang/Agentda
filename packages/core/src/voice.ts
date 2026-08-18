import { execFile } from 'node:child_process'
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Voice notes (ADR 0004). Local by default, because the transcript can approve
// a consequential action and because a voice note is the user's actual voice.
// Nothing here falls back silently: a missing binary is reported, not routed to
// a vendor.
export type VoiceBackend = 'local' | 'openai' | 'off'

export interface VoiceConfig {
  backend: VoiceBackend
  whisperBin?: string
  whisperModel?: string
  openaiKey?: string
  openaiModel?: string
  ffmpegBin?: string
}

export function voiceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const backend = (env.AGENTDA_VOICE ?? 'local') as VoiceBackend
  return {
    backend: backend === 'openai' || backend === 'off' ? backend : 'local',
    whisperBin: env.AGENTDA_WHISPER_BIN ?? 'whisper-cli',
    whisperModel: env.AGENTDA_WHISPER_MODEL,
    ffmpegBin: env.AGENTDA_FFMPEG_BIN ?? 'ffmpeg',
    openaiKey: env.OPENAI_API_KEY,
    openaiModel: env.AGENTDA_VOICE_MODEL ?? 'whisper-1',
  }
}

export class VoiceUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoiceUnavailable'
  }
}

// OGG/Opus in, text out. The audio never touches the bot directory: a recording
// is not something to leave lying around next to the memory files.
export async function transcribe(audio: Buffer, cfg: VoiceConfig): Promise<string> {
  if (cfg.backend === 'off') throw new VoiceUnavailable('voice notes are turned off for this daemon (AGENTDA_VOICE=off)')
  return cfg.backend === 'openai' ? viaOpenAI(audio, cfg) : viaWhisperCpp(audio, cfg)
}

async function viaWhisperCpp(audio: Buffer, cfg: VoiceConfig): Promise<string> {
  if (!cfg.whisperModel) {
    throw new VoiceUnavailable(
      'local transcription needs a Whisper model: set AGENTDA_WHISPER_MODEL to a ggml .bin file (see docs/adr/0004)',
    )
  }
  const dir = mkdtempSync(join(tmpdir(), 'agentda-voice-'))
  const ogg = join(dir, 'note.ogg')
  const wav = join(dir, 'note.wav')
  writeFileSync(ogg, audio)
  try {
    // whisper.cpp only reads 16 kHz mono WAV, so ffmpeg is not optional here.
    await run(cfg.ffmpegBin ?? 'ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', ogg, '-ar', '16000', '-ac', '1', wav])
    // -nt drops timestamps, -np drops the model banner, so stdout is the
    // transcript and nothing else.
    const { stdout } = await run(cfg.whisperBin ?? 'whisper-cli', ['-m', cfg.whisperModel, '-f', wav, '-nt', '-np'])
    const text = stdout.trim()
    if (!text) throw new VoiceUnavailable('transcription came back empty')
    return text
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      throw new VoiceUnavailable(
        `${/ffmpeg/.test(String(e.path ?? '')) ? 'ffmpeg' : 'whisper-cli'} is not installed — \`brew install ffmpeg whisper-cpp\`, or set AGENTDA_VOICE=openai to transcribe in the cloud instead`,
      )
    }
    throw err
  } finally {
    for (const f of [ogg, wav]) {
      try {
        unlinkSync(f)
      } catch {
        // best effort: the temp dir goes with the reboot anyway
      }
    }
  }
}

async function viaOpenAI(audio: Buffer, cfg: VoiceConfig): Promise<string> {
  if (!cfg.openaiKey) throw new VoiceUnavailable('AGENTDA_VOICE=openai needs OPENAI_API_KEY')
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'note.ogg')
  form.append('model', cfg.openaiModel ?? 'whisper-1')
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.openaiKey}` },
    body: form,
  })
  if (!res.ok) throw new VoiceUnavailable(`transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  return String((await res.json()).text ?? '').trim()
}

// Kept out of the transcribers so tests can read a fixture instead of the
// network, and so the Telegram-specific URL shape lives with the caller.
export async function fetchAudio(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new VoiceUnavailable(`could not download the voice note (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}
