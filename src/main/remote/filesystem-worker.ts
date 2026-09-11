// SPDX-License-Identifier: GPL-3.0-only
/** Separate companion process; see vendor/local-workspace/COPYING and README.md. */
import { realpath, stat } from 'node:fs/promises'
import { executeOperation } from '../../../vendor/local-workspace/local-workspace-cli'

interface Request { root: string; operation: 'read' | 'write' | 'edit' | 'glob' | 'grep'; args: Record<string, unknown> }
const port = (process as NodeJS.Process & {
  parentPort?: { once(event: 'message', listener: (event: { data: Request }) => void): void; postMessage(message: unknown): void }
}).parentPort

async function run(request: Request): Promise<void> {
  const send = (value: unknown) => port ? port.postMessage(value) : process.send?.(value)
  try {
    if (!['read', 'write', 'edit', 'glob', 'grep'].includes(request.operation)) throw new Error('文件操作未授权')
    if (await realpath(request.root) !== request.root || !(await stat(request.root)).isDirectory()) throw new Error('授权目录已移动或被替换，请重新选择')
    const value = await executeOperation({ root: request.root, shellEnabled: false, server: '', workspaceId: '', deviceName: '', workspaceName: '' }, request.operation, request.args, new AbortController().signal)
    send({ ok: true, value })
  } catch (error) { send({ ok: false, error: error instanceof Error ? error.message : '文件操作失败' }) }
}
if (port) port.once('message', event => { void run(event.data) })
else process.once('message', (request: Request) => { void run(request) })
