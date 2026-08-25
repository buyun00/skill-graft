export const inject = ['connection']

export function apply(ctx: any): void {
  const execute = (command: unknown, signal?: AbortSignal) => (
    ctx.connection.rpc.call('/skill-graft', 'execute', { command }, signal)
  )
  ctx.provide('skillGraft', Object.freeze({ execute }))
}
