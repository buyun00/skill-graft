import fs from 'node:fs'
import { TextDecoder } from 'node:util'

const args = process.argv.slice(2)
const promptChunks = []
for await (const chunk of process.stdin) promptChunks.push(Buffer.from(chunk))
const prompt = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(promptChunks))
const resume = args[0] === 'exec' && args[1] === 'resume'
const outputIndex = args.indexOf('-o')
const output = outputIndex >= 0 ? args[outputIndex + 1] : ''
const threadId = '019cfake0-0000-7000-8000-000000000001'

process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`)

if (String(prompt).includes('CANCEL_BLOCK')) {
  setInterval(() => {}, 1000)
} else {
  if (output) fs.writeFileSync(output, resume ? 'resumed\n' : 'started\n', 'utf8')
  process.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: { id: 'item-1', type: 'agent_message', text: 'ignored model text' }
  })}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
}
