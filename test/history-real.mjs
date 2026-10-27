import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { listConversations } from '../lib/agy-conversations.js'
import { readConversationHistory } from '../lib/agy-history.js'

const home = join(homedir(), '.dsh')
const registry = JSON.parse(readFileSync(join(home, 'agy-conversations.json'), 'utf8'))
const records = registry.records ?? registry
const gem = join(homedir(), '.gemini', 'antigravity-cli')

const items = listConversations({
  records,
  conversationsDir: join(gem, 'conversations'),
  annotationsDir: join(gem, 'annotations'),
})
console.log(`conversations: ${items.length}`)

for (const item of items.slice(0, 4)) {
  const history = await readConversationHistory(item.conversationId, join(gem, 'conversations'))
  console.log('='.repeat(70))
  console.log(`${item.label}  [${item.conversationId.slice(0, 8)}]  model=${item.model}`)
  console.log(`steps=${history.steps.length} / ${history.stepCount}  source=${history.source}${history.error ? ` error=${history.error}` : ''}`)
  for (const step of history.steps.slice(0, 6)) {
    const head = `  [${step.type}] ${step.tool?.name ?? ''} ${step.state ?? ''}`.trimEnd()
    console.log(head)
    if (step.text) console.log(`      ${step.text.slice(0, 160).replace(/\n/g, '\n      ')}`)
    if (step.tool?.parameters) console.log(`      params: ${JSON.stringify(step.tool.parameters).slice(0, 160)}`)
  }
}
