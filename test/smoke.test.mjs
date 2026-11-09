import assert from 'node:assert/strict'
import { apply } from '../index.js'

const T0 = 1_700_000_000_000

function event (seq, type, data, time) {
  return { seq, type, time, data }
}

function userEvent (seq, text, time) {
  return event(seq, 'user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, time)
}

function assistantEvent (seq, text, time) {
  return event(seq, 'assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
    stream: [],
  }, time)
}

// Root: 8 shared events, then its own continuation.
const rootEvents = [
  event(0, 'permission/preset', { preset: 'workspace-write' }, T0),
  event(1, 'sandbox/mode', { mode: 'workspace-write' }, T0 + 1),
  userEvent(2, 'start the OCR task', T0 + 2),
  assistantEvent(3, 'ok, working on it', T0 + 3),
  event(4, 'session/title', { title: 'Book OCR', messageSeqs: [], source: { kind: 'user' } }, T0 + 4),
  userEvent(5, 'check the format', T0 + 5),
  assistantEvent(6, 'checked', T0 + 6),
  event(7, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, T0 + 7),
  userEvent(8, 'root-only follow-up', T0 + 8),
  assistantEvent(9, 'root-only answer', T0 + 9),
]

// Branch: copies the first 8 events, then its own tail.
const branchEvents = [
  ...rootEvents.slice(0, 8).map(item => ({ ...item })),
  event(8, 'session/end-seed', { inherited: true }, T0 + 100),
  event(9, 'session/title', { title: 'Book OCR (1)', messageSeqs: [], source: { kind: 'user' } }, T0 + 101),
  event(10, 'user/message', {
    role: 'user',
    content: [{ type: 'text', text: 'Time sampled while preparing turn 3, step 1: 2026-11-09T19:54:57+08:00[Asia/Shanghai]' }],
    source: { kind: 'time-context', form: 'snapshot', sections: [] },
  }, T0 + 101.5),
  userEvent(11, 'now restore the layout 1:1', T0 + 102),
  assistantEvent(12, 'restoring layout', T0 + 103),
  event(13, 'turn/end', { turn: 3, reason: { kind: 'completed' } }, T0 + 104),
]

// Unrelated session in the same workspace.
const otherEvents = [
  event(0, 'permission/preset', { preset: 'workspace-write' }, T0 + 5000),
  userEvent(1, 'unrelated question', T0 + 5001),
]

const sessions = new Map()
function makeSession (id, header, events, inherited) {
  return {
    id,
    header,
    inheritedEventCount: inherited,
    snapshotEvents: () => events,
  }
}

const rootSession = makeSession('session-root', { id: 'session-root', createdAt: T0, cwd: 'D:\\ws', isSeeded: false }, rootEvents, 0)
const branchSession = makeSession('session-branch', { id: 'session-branch', createdAt: T0 + 100, cwd: 'D:\\ws', isSeeded: true }, branchEvents, 8)
sessions.set('session-root', rootSession)
sessions.set('session-branch', branchSession)

const records = [
  { header: { ...branchSession.header }, live: true, persisted: true },
  { header: { id: 'session-other', createdAt: T0 + 5000, cwd: 'D:\\ws', isSeeded: false }, live: false, persisted: true },
  { header: { ...rootSession.header }, live: true, persisted: true },
  { header: { id: 'session-sub', createdAt: T0 + 200, cwd: 'D:\\ws', isSeeded: true, origin: 'subagent', parentSession: 'session-root' }, live: false, persisted: true },
]

const tools = new Map()
const sections = []
const ctx = {
  tools: { register: definition => { tools.set(definition.name, definition); return () => {} } },
  systemPrompt: { section: section => { sections.push(section); return () => {} } },
  sessions: { get: id => sessions.get(id) },
  get: name => name === 'sessionQuery' ? {
    listSessions: async () => records,
    readEvent: async ({ sessionId, seq }) => {
      const session = sessions.get(sessionId)
      const events = session !== undefined
        ? session.snapshotEvents()
        : sessionId === 'session-other' ? otherEvents : undefined
      if (events === undefined) throw new Error('not found')
      const target = events[seq]
      if (target === undefined) throw new Error('no such event')
      return {
        session: session !== undefined ? session.header : records.find(r => r.header.id === sessionId).header,
        inheritedEventCount: session !== undefined ? session.inheritedEventCount : 0,
        target,
        events: [target],
        startSeq: seq,
        endSeq: seq,
      }
    },
    readSession: async sessionId => {
      const session = sessions.get(sessionId)
      if (session !== undefined) return { session: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() }
      if (sessionId === 'session-other') return { session: records[1].header, inheritedEventCount: 0, events: otherEvents }
      throw new Error('not found')
    },
  } : undefined,
}

apply(ctx)

const listTool = tools.get('branch_list')
const readTool = tools.get('branch_read')
assert.ok(listTool, 'branch_list registered')
assert.ok(readTool, 'branch_read registered')
assert.equal(sections.length, 1, 'one prompt section')
assert.equal(sections[0].name, 'conversation-branches')
assert.ok(sections[0].text.includes('branch_list'))

const listFromRoot = await listTool.execute({}, { agent: { session: rootSession } })
console.log('--- branch_list from root')
console.log(listTool.output.render({}, listFromRoot)[0].text)
assert.equal(listFromRoot.branches.length, 1)
assert.equal(listFromRoot.branches[0].sessionId, 'session-branch')
assert.equal(listFromRoot.branches[0].relation, 'fork')
assert.equal(listFromRoot.branches[0].divergedAtSeq, 8)
assert.equal(listFromRoot.branches[0].messages.length, 1)
assert.equal(listFromRoot.branches[0].messages[0].seq, 11)
assert.equal(listFromRoot.branches[0].title, 'Book OCR (1)')
assert.equal(listFromRoot.current.isBranch, false)

const listFromBranch = await listTool.execute({}, { agent: { session: branchSession } })
console.log('--- branch_list from branch')
console.log(listTool.output.render({}, listFromBranch)[0].text)
assert.equal(listFromBranch.current.isBranch, true)
assert.equal(listFromBranch.branches.length, 1)
assert.equal(listFromBranch.branches[0].sessionId, 'session-root')
assert.equal(listFromBranch.branches[0].relation, 'source')
assert.deepEqual(listFromBranch.branches[0].messages.map(m => m.text), ['root-only follow-up'])
assert.equal(listFromBranch.branches[0].ownEventCount, 2)

const read = await readTool.execute({ session_id: 'session-root' }, { agent: { session: branchSession } })
console.log('--- branch_read from branch, source')
console.log(readTool.output.render({}, read)[0].text)
assert.equal(read.fromSeq, 8)
assert.deepEqual(read.messages.map(m => m.role), ['user', 'assistant'])

const readPaged = await readTool.execute({ session_id: 'session-root', from_seq: 9, limit: 1 }, { agent: { session: branchSession } })
assert.equal(readPaged.messages.length, 1)
assert.equal(readPaged.messages[0].role, 'assistant')

const readBranch = await readTool.execute({ session_id: 'session-branch', from_seq: 8 }, { agent: { session: rootSession } })
console.log('--- branch_read of the branch itself')
console.log(readTool.output.render({}, readBranch)[0].text)
assert.deepEqual(readBranch.messages.map(m => m.role), ['user', 'assistant'])
assert.equal(readBranch.messages[0].seq, 11, 'injected time-context message excluded')

await assert.rejects(
  () => readTool.execute({ session_id: 'session-other' }, { agent: { session: branchSession } }),
  /does not share this conversation's history/,
)

const noAgent = await assert.rejects(() => listTool.execute({}, {}), /requires an owning Agent Session/)

console.log('\nall assertions passed')
