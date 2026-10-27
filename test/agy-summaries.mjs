import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { readConversationSummaries } from '../lib/agy-summaries.js'
import { listConversations } from '../lib/agy-conversations.js'

const scratch = join(tmpdir(), `agy-summaries-${process.pid}`)
mkdirSync(scratch, { recursive: true })

let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    throw error
  }
}

const dbPath = join(scratch, 'conversation_summaries.db')
const db = new DatabaseSync(dbPath)
db.exec(`create table conversation_summaries (
  conversation_id text primary key,
  title text,
  preview text,
  step_count integer,
  last_modified_time text,
  last_user_input_time text,
  status text
)`)
const insert = db.prepare(
  'insert into conversation_summaries values (?, ?, ?, ?, ?, ?, ?)',
)
insert.run('aaaaaaaa-0000-4000-8000-00000000000a', '标题 A', '预览 A', 12, '2026-10-27 10:17:27+00:00', '2026-10-27 09:00:00+00:00', 'CASCADE_RUN_STATUS_IDLE')
// The zero time means "never" — it must not become a date.
insert.run('bbbbbbbb-0000-4000-8000-00000000000b', null, null, 0, '0001-01-01 00:00:00+00:00', '0001-01-01 00:00:00+00:00', null)
db.close()

await check('summary rows are read back with their metadata', async () => {
  const summaries = await readConversationSummaries(dbPath)
  assert.equal(summaries.size, 2)
  const a = summaries.get('aaaaaaaa-0000-4000-8000-00000000000a')
  assert.equal(a.title, '标题 A')
  assert.equal(a.preview, '预览 A')
  assert.equal(a.stepCount, 12)
  assert.equal(a.status, 'CASCADE_RUN_STATUS_IDLE')
  assert.equal(a.lastModifiedAt, Date.parse('2026-10-27T10:17:27Z'))
  assert.equal(a.lastUserInputAt, Date.parse('2026-10-27T09:00:00Z'))
})

await check('the zero time is not a date', async () => {
  const summaries = await readConversationSummaries(dbPath)
  const b = summaries.get('bbbbbbbb-0000-4000-8000-00000000000b')
  assert.equal(b.lastModifiedAt, null)
  assert.equal(b.lastUserInputAt, null)
  assert.equal(b.title, null)
  assert.equal(b.status, null)
})

await check('a missing database yields an empty map', async () => {
  const summaries = await readConversationSummaries(join(scratch, 'nothing-here.db'))
  assert.equal(summaries.size, 0)
})

await check('the conversation list carries the summary metadata', async () => {
  const conversationsDir = join(scratch, 'conversations')
  mkdirSync(conversationsDir, { recursive: true })
  writeFileSync(join(conversationsDir, 'aaaaaaaa-0000-4000-8000-00000000000a.db'), '')
  const summaries = await readConversationSummaries(dbPath)
  const items = listConversations({
    records: {
      'k1': { conversationId: 'aaaaaaaa-0000-4000-8000-00000000000a', cwd: scratch, label: '', createdAt: 1000 },
    },
    conversationsDir,
    annotationsDir: join(scratch, 'annotations'),
    summaries,
  })
  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item.label, '标题 A')
  assert.equal(item.stepCount, 12)
  assert.equal(item.preview, '预览 A')
  assert.equal(item.status, 'CASCADE_RUN_STATUS_IDLE')
  assert.equal(item.lastActivityAt, Date.parse('2026-10-27T10:17:27Z'))
})

await check('without a summary the list keeps the registry timestamp', async () => {
  const conversationsDir = join(scratch, 'conversations')
  const items = listConversations({
    records: {
      'k1': { conversationId: 'aaaaaaaa-0000-4000-8000-00000000000a', cwd: scratch, label: '本地标签', createdAt: 1000 },
    },
    conversationsDir,
    annotationsDir: join(scratch, 'annotations'),
  })
  assert.equal(items[0].label, '本地标签')
  assert.equal(items[0].lastActivityAt, 1000)
  assert.equal(items[0].stepCount, 0)
})

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
