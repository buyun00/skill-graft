import fs from 'node:fs'

const args = process.argv.slice(2)
const prompt = await new Promise((resolve) => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { value += chunk })
  process.stdin.on('end', () => resolve(value))
})
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
