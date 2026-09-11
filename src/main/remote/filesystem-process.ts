import { utilityProcess } from 'electron'
import { join } from 'node:path'
import type { ExecuteFile } from './connection'
import { record } from './gateway'

/** Per-operation process bounds filesystem work, regex CPU time and cancellation lifetime. */
export const executeFile: ExecuteFile = (root, operation, args, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('文件操作已取消')); return }
  const child = utilityProcess.fork(join(__dirname, 'filesystem-worker.js'), [], { stdio: 'ignore', serviceName: 'Tizhi Local Folder' })
  const finish = (error?: Error, value?: unknown) => {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    child.removeAllListeners()
    child.kill()
    if (error) reject(error)
    else resolve(value)
  }
  const abort = () => finish(new Error('文件操作已取消'))
  const timer = setTimeout(() => finish(new Error('文件操作超过 30 秒，已停止')), 30_000)
  signal.addEventListener('abort', abort, { once: true })
  child.once('spawn', () => child.postMessage({ root, operation, args }))
  child.once('exit', () => finish(new Error('本机文件进程已退出')))
  child.once('message', value => {
    try {
      const result = record(value)
      if (result.ok !== true) throw new Error(typeof result.error === 'string' ? result.error : '文件操作失败')
      finish(undefined, result.value)
    } catch (error) { finish(error instanceof Error ? error : new Error('文件进程响应无效')) }
  })
})
