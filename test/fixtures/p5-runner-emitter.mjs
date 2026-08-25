import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { TextDecoder } from 'node:util'

const mode = process.argv[2] || 'complete'
const pidFile = process.argv[3] || ''
const lastMessageFile = process.argv[4] || ''
const environmentReportFile = process.argv[5] || ''
const promptReportFile = process.argv[6] || ''

if (mode === 'capture-utf8') {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const input = Buffer.concat(chunks)
  new TextDecoder('utf-8', { fatal: true }).decode(input)
  if (promptReportFile) fs.writeFileSync(promptReportFile, input)
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '019cfake0-0000-7000-8000-000000000001' }))
  console.log(JSON.stringify({ type: 'turn.started' }))
  console.log(JSON.stringify({ type: 'turn.completed' }))
  process.exit(0)
}

process.stdin.resume()

console.log(JSON.stringify({ type: 'thread.started', thread_id: '019cfake0-0000-7000-8000-000000000001' }))
console.log(JSON.stringify({ type: 'turn.started' }))
console.error('stderr UTF-8: 结构化运行器')

if (mode === 'complete') {
  if (environmentReportFile) {
    fs.writeFileSync(environmentReportFile, `${JSON.stringify({
      providerSecretInherited: Boolean(process.env.OPENAI_API_KEY),
      home: process.env.HOME,
      appData: process.env.APPDATA,
      temp: process.env.TEMP,
      pathPresent: Boolean(process.env.PATH)
    })}\n`, 'utf8')
  }
  console.log(JSON.stringify({
    type: 'item.started',
    item: { id: 'item-1', type: 'command_execution', text: 'must not enter normalized events' }
  }))
  if (lastMessageFile) fs.writeFileSync(lastMessageFile, '真实最后消息\n', 'utf8')
  console.log(JSON.stringify({ type: 'turn.completed' }))
  process.exit(0)
}

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true
})
if (pidFile) fs.writeFileSync(pidFile, `${grandchild.pid}\n`, 'utf8')
setInterval(() => {
  console.log(JSON.stringify({ type: 'item.updated', item: { id: 'heartbeat', type: 'command_execution' } }))
}, 100)
