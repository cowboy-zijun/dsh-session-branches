/**
 * Conversation branches — lets the model discover and read the forked branches
 * of the conversation it is running in.
 *
 * A DSH "branch" action forks one Session into an independent Session whose log
 * begins with an exact copy of the source prefix. The child header records
 * `isSeeded: true` but deliberately no `parentSession`, so neither
 * `sessionQuery.traceSession()` nor the subagent catalog can see the relation.
 * The only durable link is the copied prefix, so this plugin groups Sessions by
 * an identical first event (a fork copies it verbatim, timestamp included) and
 * then compares logs to find the exact divergence point.
 *
 * Model-facing surface: `branch_list` and `branch_read`, plus one prompt
 * section that explains when to use them.
 *
 * @module @local/dsh-session-branches
 */

export const name = 'session-branches'

export const inject = ['tools', 'systemPrompt', 'sessions']

/** Session-log probes budget for one discovery pass. */
const MAX_CANDIDATES = 80
/** Branches returned by one `branch_list` call. */
const MAX_BRANCHES = 8
/** Branches considered by one `branch_read` call before matching. */
const MAX_READ_CANDIDATES = 40
const DEFAULT_PREVIEW = 5
const MAX_PREVIEW = 20
const DEFAULT_READ = 20
const MAX_READ = 60
/** Character budget for one `branch_read` rendering. */
const READ_CHARS = 32000
/** Per-message preview budget in `branch_list`. */
const PREVIEW_CHARS = 320

const LIST_TOOL = 'branch_list'
const READ_TOOL = 'branch_read'

const SECTION = `## Conversation branches
A DSH conversation can be forked ("branched") from a completed turn. A branch is an independent Session that copies this conversation's events up to that turn; this Session's own history never shows it.
- \`${LIST_TOOL}\` finds Sessions that share this conversation's history and reports each branch's title, fork point, and own prompts.
- \`${READ_TOOL}\` reads one branch's messages from its fork point.
Call \`${LIST_TOOL}\` whenever the user mentions another branch, an edited or alternative version of the conversation, comparing alternatives, or asks what happened in a side thread.`

/** User-role messages the harness injected as context, never what the human typed. */
function isHumanUserEvent (event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function asNumber (value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clip (text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Concatenate the text blocks of a message content list.
 * @param {unknown} blocks
 * @returns {string}
 */
function textOf (blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim()
      if (text !== '') parts.push(text)
    }
  }
  return parts.join('\n\n')
}

/**
 * @param {any} event
 * @returns {'user' | 'assistant' | undefined}
 */
function roleOf (event) {
  if (event?.type === 'user/message') return 'user'
  if (event?.type === 'assistant/message') return 'assistant'
  return undefined
}

/**
 * @param {any} event
 * @returns {string}
 */
function textOfEvent (event) {
  if (event?.type === 'user/message') return textOf(event.data?.content)
  if (event?.type === 'assistant/message') return textOf(event.data?.message?.content)
  return ''
}

/**
 * Latest durable title of one Session log.
 * @param {readonly any[]} events
 * @param {string} fallback
 * @returns {string}
 */
function titleOf (events, fallback) {
  let title
  for (const event of events) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  return typeof title === 'string' && title !== '' ? title : fallback
}

/**
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
function sameEvent (left, right) {
  if (left === undefined || right === undefined) return false
  if (left.time !== right.time || left.type !== right.type) return false
  return JSON.stringify(left.data) === JSON.stringify(right.data)
}

/**
 * Length of the identical leading run of two Session logs.
 * @param {readonly any[]} left
 * @param {readonly any[]} right
 * @returns {number}
 */
function sharedPrefix (left, right) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit) {
    const a = left[index]
    const b = right[index]
    if (a.seq !== b.seq || a.type !== b.type || a.time !== b.time) return index
    if (JSON.stringify(a.data) !== JSON.stringify(b.data)) return index
    index += 1
  }
  return index
}

/**
 * Snapshot the live Session the model is running in.
 * @param {any} session
 * @returns {{ id: string, header: any, events: readonly any[], inherited: number }}
 */
function liveSnapshot (session) {
  return {
    id: String(session.id),
    header: session.header,
    events: session.snapshotEvents(),
    inherited: asNumber(session.inheritedEventCount),
  }
}

/**
 * First event of a probe, whether it came from a live Session or a cold read.
 * @param {any} probe
 * @returns {any}
 */
function firstOf (probe) {
  return probe.events === undefined ? probe.first : probe.events[0]
}

/**
 * Enumerate the Sessions that share this conversation's copied prefix.
 * @param {any} ctx
 * @param {any} session - the calling Session (live).
 * @param {{ maxBranches?: number }} [options]
 * @returns {Promise<{ current: any, branches: any[], probed: number, scanned: number }>}
 */
async function discover (ctx, session, options = {}) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || query === null) {
    throw new Error('This profile has no session query service, so conversation branches cannot be read.')
  }
  const current = liveSnapshot(session)
  const first = current.events[0]
  if (first === undefined) return { current, branches: [], probed: 0, scanned: 0 }

  let records
  try {
    records = await query.listSessions()
  } catch (error) {
    throw new Error(`Cannot list Sessions: ${messageOf(error)}`)
  }

  const candidates = []
  for (const record of records) {
    const header = record?.header
    if (header === undefined || header === null) continue
    if (String(header.id) === current.id) continue
    if (header.origin === 'subagent' || header.parentSession !== undefined) continue
    // A fork copies its source prefix, so it cannot predate this lineage's first event.
    if (asNumber(header.createdAt) < asNumber(first.time)) continue
    if (candidates.length >= MAX_CANDIDATES) break
    candidates.push(record)
  }

  const probes = []
  for (const record of candidates) {
    const id = String(record.header.id)
    const live = ctx.sessions.get(id)
    if (live !== undefined && live !== null) {
      probes.push({
        id,
        header: live.header,
        events: live.snapshotEvents(),
        inherited: asNumber(live.inheritedEventCount),
        live: true,
      })
      continue
    }
    try {
      const window = await query.readEvent({ sessionId: id, seq: 0, before: 0, after: 0 })
      probes.push({
        id,
        header: window.session,
        events: undefined,
        first: window.target,
        inherited: asNumber(window.inheritedEventCount),
        live: false,
      })
    } catch {
      // An empty, missing, or migration-blocked log cannot share this history.
    }
  }

  const matched = probes.filter(probe => sameEvent(firstOf(probe), first))
  const branches = []
  for (const probe of matched) {
    let events = probe.events
    if (events === undefined) {
      try {
        const snapshot = await query.readSession(probe.id)
        events = snapshot.events
        probe.header = snapshot.session
        probe.inherited = asNumber(snapshot.inheritedEventCount)
      } catch {
        continue
      }
    }
    const shared = sharedPrefix(current.events, events)
    if (shared <= 0) continue
    const inherited = probe.inherited
    const relation = inherited === 0
      ? 'source'
      : shared >= current.events.length ? 'descendant' : 'fork'
    branches.push({
      sessionId: probe.id,
      header: probe.header,
      events,
      inherited,
      shared,
      relation,
      live: probe.live,
    })
  }

  branches.sort((left, right) => asNumber(right.header.createdAt) - asNumber(left.header.createdAt))
  const limit = options.maxBranches ?? MAX_BRANCHES
  return {
    current,
    branches: branches.slice(0, limit),
    all: branches,
    probed: probes.length,
    scanned: candidates.length,
  }
}

/**
 * Own user prompts of one branch, newest-last, after its fork point.
 * @param {any} branch
 * @param {number} limit
 * @returns {{ messages: { seq: number, text: string }[], truncated: boolean }}
 */
function previewOf (branch, limit) {
  const messages = []
  let truncated = false
  for (let index = branch.shared; index < branch.events.length; index += 1) {
    const event = branch.events[index]
    if (!isHumanUserEvent(event)) continue
    const text = textOfEvent(event)
    if (text === '') continue
    if (messages.length >= limit) {
      truncated = true
      break
    }
    messages.push({ seq: asNumber(event.seq), text: clip(text, PREVIEW_CHARS) })
  }
  return { messages, truncated }
}

/**
 * @param {any} branch
 * @param {{ fromSeq?: number, limit?: number, includeTools?: boolean }} params
 * @returns {{ messages: any[], truncated: boolean, nextSeq: number | null }}
 */
function readOf (branch, params) {
  const start = params.fromSeq === undefined ? branch.shared : Math.max(0, asNumber(params.fromSeq))
  const limit = Math.min(MAX_READ, Math.max(1, params.limit === undefined ? DEFAULT_READ : asNumber(params.limit)))
  const includeTools = params.includeTools === true
  const messages = []
  let chars = 0
  let truncated = false
  let nextSeq = null
  for (let index = start; index < branch.events.length; index += 1) {
    const event = branch.events[index]
    if (event.seq < start) continue
    const role = roleOf(event)
    if (role === undefined) {
      if (includeTools && event.type === 'tool/call') {
        const rendered = `[tool ${String(event.data?.name ?? 'call')}]`
        if (messages.length >= limit || chars + rendered.length > READ_CHARS) {
          truncated = true
          nextSeq = asNumber(event.seq)
          break
        }
        chars += rendered.length
        messages.push({ seq: asNumber(event.seq), role: 'tool', text: rendered })
        nextSeq = asNumber(event.seq) + 1
      }
      continue
    }
    const text = textOfEvent(event)
    if (text === '') continue
    if (role === 'user' && !isHumanUserEvent(event)) continue
    if (messages.length >= limit) {
      truncated = true
      nextSeq = asNumber(event.seq)
      break
    }
    const remaining = READ_CHARS - chars
    if (remaining <= 0) {
      truncated = true
      nextSeq = asNumber(event.seq)
      break
    }
    const body = clip(text, remaining)
    chars += body.length
    messages.push({ seq: asNumber(event.seq), role, text: body })
    nextSeq = asNumber(event.seq) + 1
    if (body.length < text.length) {
      truncated = true
      break
    }
  }
  return { messages, truncated, nextSeq }
}

/**
 * @param {any} value - the `branch_list` output value.
 * @returns {string}
 */
function renderList (value) {
  const current = value.current
  const head = current.isBranch
    ? `Current Session ${current.sessionId} "${current.title}" is itself a branch (its log inherits ${current.inheritedEventCount} events).`
    : `Current Session ${current.sessionId} "${current.title}".`
  if (value.branches.length === 0) {
    return `${head}\nNo other Session shares this conversation's history, so this conversation has no readable branches. (Scanned ${value.scannedSessions} Sessions, probed ${value.probedSessions}.)`
  }
  const lines = [head, `Sessions sharing this conversation's history: ${value.branches.length}`]
  value.branches.forEach((branch, index) => {
    const createdAt = branch.createdAt
    const ownEvents = asNumber(branch.ownEventCount)
    lines.push(
      `${index + 1}. ${branch.sessionId} "${branch.title}" [${branch.relation}] — created ${createdAt}, ${branch.live ? 'live' : 'not live'}, ` +
      `fork point seq ${branch.divergedAtSeq}, ${ownEvents} own events`,
    )
    for (const message of branch.messages ?? []) {
      lines.push(`   • user (seq ${message.seq}): ${message.text.replace(/\s*\n\s*/g, ' / ')}`)
    }
    if (branch.moreUserMessages === true) lines.push('   • …more user messages; call branch_read for the rest')
  })
  return lines.join('\n')
}

/**
 * @param {any} value - the `branch_read` output value.
 * @returns {string}
 */
function renderRead (value) {
  const lines = [
    `Branch ${value.sessionId} "${value.title}" — messages from seq ${value.fromSeq} ` +
    `(${value.messages.length} shown${value.truncated ? ', truncated' : ''}).`,
  ]
  for (const message of value.messages) {
    lines.push(`[${message.seq}] ${message.role}: ${message.text}`)
  }
  if (value.truncated && value.nextSeq !== null) {
    lines.push(`(continue with from_seq=${value.nextSeq})`)
  }
  return lines.join('\n')
}

/**
 * Register both tools and the prompt section.
 * @param {any} ctx
 */
export function apply (ctx) {
  ctx.tools.register({
    name: LIST_TOOL,
    description:
      'List the branches that share this conversation\'s history. A DSH branch is a separate Session that copied this conversation up to a completed turn; ' +
      'it is invisible in this Session\'s own history. Reports each branch\'s id, title, fork point, and its own user prompts. ' +
      'Reading a branch never changes it. ' +
      'Call it when the user mentions another branch, an edited or alternative version, or asks to compare alternatives.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_messages: {
          type: 'boolean',
          description: 'Include each branch\'s own user prompts as a preview. Defaults to true.',
        },
        message_limit: {
          type: 'integer',
          description: `Maximum previewed user prompts per branch, 1-${MAX_PREVIEW}. Defaults to ${DEFAULT_PREVIEW}.`,
        },
        max_branches: {
          type: 'integer',
          description: `Maximum branches to report, 1-${MAX_PREVIEW}. Defaults to ${MAX_BRANCHES}.`,
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, description: 'Branch discovery result.' },
      render: (_args, value) => [{ type: 'text', text: renderList(value) }],
    },
    async execute (args = {}, exec) {
      const session = exec.agent?.session
      if (session === undefined || session === null) throw new Error(`${LIST_TOOL} requires an owning Agent Session.`)
      const includeMessages = args.include_messages !== false
      const messageLimit = Math.min(MAX_PREVIEW, Math.max(1, asNumber(args.message_limit ?? DEFAULT_PREVIEW)))
      const maxBranches = Math.min(MAX_PREVIEW, Math.max(1, asNumber(args.max_branches ?? MAX_BRANCHES)))
      const found = await discover(ctx, session, { maxBranches })
      const branches = found.branches.map(branch => {
        const preview = includeMessages ? previewOf(branch, messageLimit) : { messages: [], truncated: false }
        return {
          sessionId: branch.sessionId,
          title: titleOf(branch.events, branch.sessionId),
          createdAt: new Date(asNumber(branch.header.createdAt)).toISOString(),
          relation: branch.relation,
          live: branch.live,
          divergedAtSeq: branch.shared,
          ownEventCount: branch.events.length - branch.shared,
          inheritedEventCount: branch.inherited,
          messages: preview.messages,
          moreUserMessages: preview.truncated,
        }
      })
      return {
        current: {
          sessionId: found.current.id,
          title: titleOf(found.current.events, found.current.id),
          isBranch: found.current.inherited > 0,
          inheritedEventCount: found.current.inherited,
          eventCount: found.current.events.length,
        },
        branches,
        truncated: (found.all?.length ?? branches.length) > branches.length,
        scannedSessions: found.scanned,
        probedSessions: found.probed,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List conversation branches', kind: 'read' }),
  })

  ctx.tools.register({
    name: READ_TOOL,
    description:
      'Read one branch of this conversation: its messages from the fork point onward. ' +
      `Pass a Session id from ${LIST_TOOL}; omitted fromSeq starts at the fork point. ` +
      'Use it to see what was said or done in another version of this conversation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: {
          type: 'string',
          description: `Branch Session id, exactly as reported by ${LIST_TOOL}.`,
        },
        from_seq: {
          type: 'integer',
          description: 'First event seq to read. Defaults to the branch\'s fork point.',
        },
        limit: {
          type: 'integer',
          description: `Maximum messages, 1-${MAX_READ}. Defaults to ${DEFAULT_READ}.`,
        },
        include_tools: {
          type: 'boolean',
          description: 'Also list the tool names a branch called. Defaults to false.',
        },
      },
      required: ['session_id'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true, description: 'Branch message window.' },
      render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
    },
    async execute (args = {}, exec) {
      const session = exec.agent?.session
      if (session === undefined || session === null) throw new Error(`${READ_TOOL} requires an owning Agent Session.`)
      const target = String(args.session_id ?? '').trim()
      if (target === '') throw new Error(`${READ_TOOL} requires session_id.`)
      const found = await discover(ctx, session, { maxBranches: MAX_READ_CANDIDATES })
      const branch = (found.all ?? []).find(candidate => candidate.sessionId === target)
      if (branch === undefined) {
        throw new Error(
          `Session "${target}" does not share this conversation's history. ` +
          `Call ${LIST_TOOL} and use one of the reported ids.`,
        )
      }
      const fromSeq = args.from_seq === undefined ? branch.shared : Math.max(0, asNumber(args.from_seq))
      const result = readOf(branch, {
        fromSeq,
        limit: args.limit,
        includeTools: args.include_tools === true,
      })
      return {
        sessionId: branch.sessionId,
        title: titleOf(branch.events, branch.sessionId),
        fromSeq,
        messages: result.messages,
        truncated: result.truncated,
        nextSeq: result.nextSeq,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Read conversation branch', kind: 'read', rawInput: args }),
  })

  ctx.systemPrompt.section({
    name: 'conversation-branches',
    order: 900,
    text: SECTION,
  })
}
