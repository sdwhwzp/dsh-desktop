import { utilityProcess } from 'electron'
import { join } from 'node:path'
import type { ExecuteFile } from './connection'
import { record } from './gateway'

const pending = new Set<Promise<void>>()

/** App shutdown waits for cancelled commands and their utility processes to exit. */
export async function waitForLocalOperations(): Promise<void> { await Promise.all([...pending]) }

/** Each request owns a worker; cancellation lets the companion terminate its shell tree first. */
export const executeFile: ExecuteFile = (root, operation, args, signal, desktopControl) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('本机操作已取消')); return }
  const child = utilityProcess.fork(join(__dirname, 'filesystem-worker.js'), [], { stdio: 'ignore', serviceName: 'Tizhi Local Workspace' })
  let exited!: () => void
  const exit = new Promise<void>(done => { exited = done })
  pending.add(exit)
  void exit.then(() => pending.delete(exit))
  let settled = false
  let spawned = false
  let cancelled: Error | undefined
  let cancelTimer: NodeJS.Timeout | undefined
  const finish = (error?: Error, value?: unknown) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(cancelTimer)
    signal.removeEventListener('abort', abort)
    child.kill()
    if (cancelled || error) reject(cancelled || error)
    else resolve(value)
  }
  const cancel = (error: Error) => {
    if (settled || cancelled) return
    cancelled = error
    if (spawned) child.postMessage({ type: 'cancel' })
    // A non-responsive worker must not prevent logout or shutdown indefinitely.
    cancelTimer = setTimeout(() => finish(error), 5_000)
  }
  const abort = () => cancel(new Error('本机操作已取消'))
  // Shell validates its requested timeout (default 120 s, maximum 600 s) inside the worker.
  // A desktop action can carry its own wait, which the companion caps at 5 s.
  const deadline = operation === 'bash' ? 605_000 : operation === 'input' ? 60_000 : 30_000
  const timer = setTimeout(() => cancel(new Error('本机操作超时，已停止')), deadline)
  signal.addEventListener('abort', abort, { once: true })
  child.once('spawn', () => {
    spawned = true
    if (cancelled) { finish(cancelled); return }
    child.postMessage({ type: 'run', request: { root, operation, args, desktopControl } })
  })
  child.once('exit', () => { exited(); finish(new Error('本机操作进程已退出')) })
  child.once('message', value => {
    try {
      const result = record(value)
      if (result.ok !== true) throw new Error(typeof result.error === 'string' ? result.error : '本机操作失败')
      finish(undefined, result.value)
    } catch (error) { finish(error instanceof Error ? error : new Error('本机进程响应无效')) }
  })
})
