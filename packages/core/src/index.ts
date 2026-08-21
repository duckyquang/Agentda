export { SessionStore } from './store'
export { openDb, type Db } from './db'
export { type BotPolicy, type DecisionSource, decide, defaultPolicy, type GateOutcome, matches, type Mode } from './gate'
export { type ApprovalRequest, ApprovalQueue, type Resolution } from './approvals'
export { HookServer } from './hook-server'
export {
  Bridge,
  type BridgeHost,
  type BridgeTransport,
  cardBody,
  LiveChecklist,
  type OutboundRef,
  type StepStatus,
} from './bridge'
export { amendmentReason, type ApprovalReply, parseApprovalReply } from './reply'
export { fetchAudio, transcribe, type VoiceBackend, type VoiceConfig, voiceConfigFromEnv, VoiceUnavailable } from './voice'
export { type BudgetVerdict, checkBudget, type Guardrails, recordTurn } from './budget'
export {
  appendRoutine,
  archivePersona,
  createPersona,
  loadPersona,
  loadPersonas,
  memoryDir,
  type Persona,
  type PersonaPatch,
  readMemory,
  setConfigValues,
  updatePersona,
  setPersonaMode,
  writeMemory,
} from './persona'
export { TurnRunner, type TurnResult } from './runner'
export { type RoutineOutcome, Scheduler } from './scheduler'
export { type CompileResult, compileRoutine, type RawAction, renderRoutineToml } from './recorder'
export {
  EXPECT_KINDS,
  type ExpectKind,
  loadRoutine,
  parseExpect,
  refuseReplayOnCodex,
  type Routine,
  type RoutineStep,
  type StepVerb,
  validateRoutine,
  verbTool,
} from './routine'
export { Owners, type Role } from './owners'
export { resolveInScope, safeMemoryName } from './scope'
export {
  loadPack,
  loadPacks,
  missingEnv,
  type Pack,
  type PackGrants,
  packGrants,
  type PackServer,
  refuseOnCodex,
  withPacks,
} from './packs'
export { TokenStore } from './tokens'
export {
  failoverNotice,
  type FailoverStep,
  nextProvider,
  type ProviderChoice,
  shouldFailover,
} from './failover'
export { DEFAULT_HANDOFF_CAP, type Handoff, handoffCount, parseHandoffs, recordHandoff, tryHandoff } from './handoff'

// Normalized events every provider adapter emits. Kept exactly as big as the
// Claude adapter needs (PLAN Phase 0); grows only when a second adapter demands it.
export type AgentEvent =
  | { type: 'text'; text: string } // streamed assistant text delta
  | { type: 'tool_call'; name: string; input: unknown }
  | {
      // Yielded only for successful turns; failures arrive as a thrown
      // AdapterError, so there is exactly one failure signal.
      type: 'result'
      sessionId: string
      resultText?: string
      costUsd?: number // provider's own estimate, not a measurement
      numTurns?: number
      raw: unknown
    }
  | { type: 'warning'; message: string }

export type AdapterErrorKind = 'auth' | 'limit' | 'killed' | 'other'

export class AdapterError extends Error {
  constructor(
    public kind: AdapterErrorKind,
    message: string,
    public hint?: string, // provider-specific remediation, ready to show a human
  ) {
    super(message)
    this.name = 'AdapterError'
  }
}

export interface ProviderAdapter {
  name: string
  capabilities: { streaming: boolean; tools: boolean; midTurnGating: boolean }
  // One provider turn. Pass resume to continue an existing provider session;
  // the new/continued session id arrives on the 'result' event. Adapters accept
  // their own extra options (tool grants, gate wiring) on the same object.
  startTurn(input: string, opts?: { resume?: string; [k: string]: unknown }): AsyncIterable<AgentEvent>
}
