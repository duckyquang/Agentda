// Free-text approval answers (PRD FR-21). Buttons are the primary path, but a
// card that arrives while you are typing deserves a typed answer, and voice
// notes transcribe to text — so "yes", "nope", and "approve but cc anna" all
// have to land somewhere.
//
// Deliberately conservative: anything this does not clearly recognise returns
// undefined and is treated as an ordinary message. Guessing wrong here means
// either running something nobody approved or dropping a real instruction.

export type ApprovalReply =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'amend'; instruction: string }

const YES = /^(y|yes|yeah|yep|yup|ok|okay|sure|go|go ahead|do it|approve[d]?|allow(ed)?|send it|ship it|👍|✅)$/
const NO = /^(n|no|nope|nah|stop|don'?t|deny|denied|reject(ed)?|cancel|abort|👎|❌|🛑)$/

// A refusal with something after it. Imperatives are unambiguous whatever
// follows; a bare "no" needs a punctuation break, because "no idea what that
// does" is a question, not an answer.
const NO_MORE = /^(don'?t|do not|stop|cancel|abort|deny|reject)\b/
const NO_BREAK = /^(no|nope|nah)\b\s*[,.;:—-]/

// "approve but cc anna" / "yes, and use the other address" / "ok except drop the attachment"
const AMEND = /^(y|yes|yeah|yep|ok|okay|sure|approve[d]?|allow)\b[\s,]*(?:but|and|with|except|only|-)\s+(.{2,})$/s

const normalize = (s: string) => s.trim().toLowerCase().replace(/[.!]+$/, '')

export function parseApprovalReply(text: string): ApprovalReply | undefined {
  const t = normalize(text)
  if (!t) return undefined
  // No first, and no amendments off a no: "don't send it but cc anna" approves
  // nothing, and reading it as an amendment would turn a refusal into a
  // modified go-ahead.
  if (NO.test(t) || NO_MORE.test(t) || NO_BREAK.test(t)) return { kind: 'deny' }
  if (YES.test(t)) return { kind: 'allow' }
  const m = AMEND.exec(text.trim())
  if (m) return { kind: 'amend', instruction: m[2].trim() }
  return undefined
}

// An amendment is delivered to the model as a denial carrying the instruction,
// not as a silent rewrite of the tool input it already decided to send. The
// model makes the change and asks again, so the human sees a fresh card with
// the real payload and taps once more — which is the point (FR-21). It also
// means one mechanism covers every provider: a denial reason reaches the model
// on Claude, Codex, and our own loop alike.
export function amendmentReason(instruction: string): string {
  return `the owner did not approve this as written. They asked for: ${instruction}. Make that change and request the action again — do not proceed with the original.`
}
