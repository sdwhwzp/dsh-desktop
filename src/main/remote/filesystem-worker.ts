// SPDX-License-Identifier: GPL-3.0-only
/** Separate companion process; see vendor/local-workspace/COPYING and README.md. */
import { realpath, stat } from 'node:fs/promises'
import { executeOperation } from '../../../vendor/local-workspace/local-workspace-cli'

interface Request { root: string; operation: 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'bash'; args: Record<string, unknown> }
type Message = { type: 'run'; request: Request } | { type: 'cancel' }
const port = (process as NodeJS.Process & {
  parentPort?: { on(event: 'message', listener: (event: { data: Message }) => void): void; postMessage(message: unknown): void }
}).parentPort
const controller = new AbortController()
let started = false

async function run(request: Request): Promise<void> {
  const send = (value: unknown) => port ? port.postMessage(value) : process.send?.(value)
  try {
    if (!['read', 'write', 'edit', 'glob', 'grep', 'bash'].includes(request.operation)) throw new Error('本机操作未授权')
    if (await realpath(request.root) !== request.root || !(await stat(request.root)).isDirectory()) throw new Error('授权目录已移动或被替换，请重新选择')
    controller.signal.throwIfAborted()
    const value = await executeOperation({ root: request.root, shellEnabled: true, server: '', workspaceId: '', deviceName: '', workspaceName: '' }, request.operation, request.args, controller.signal)
    send({ ok: true, value })
  } catch (error) { send({ ok: false, error: error instanceof Error ? error.message : '文件操作失败' }) }
}
function receive(message: Message): void {
  if (message.type === 'cancel') controller.abort()
  else if (!started) { started = true; void run(message.request) }
}
if (port) port.on('message', event => receive(event.data))
else process.on('message', (message: Message) => receive(message))
process.once('disconnect', () => controller.abort())
