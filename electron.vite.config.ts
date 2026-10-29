delete process.env.ELECTRON_RUN_AS_NODE
import { defineConfig, externalizeDepsPlugin, type UserConfig } from 'electron-vite'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { packagedImportsPlugin } = require('./scripts/packaged-imports.cjs') as {
  packagedImportsPlugin(dependencies: Record<string, string>, preload?: boolean): import('rollup').Plugin
}
const { dependencies } = require('./package.json') as { dependencies: Record<string, string> }

export default defineConfig(({ mode }): UserConfig => mode === 'remote' ? {
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/remote-entry.ts'), 'filesystem-worker': resolve('src/main/remote/filesystem-worker.ts') }, output: { entryFileNames: '[name].js' } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { remote: resolve('src/preload/remote.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: { root: resolve('src/remote'), build: { outDir: resolve('out/remote'), rollupOptions: { input: resolve('src/remote/index.html') } } }
} : {
  main: {
    plugins: [externalizeDepsPlugin(), packagedImportsPlugin(dependencies)]
  },
  preload: {
    plugins: [externalizeDepsPlugin(), packagedImportsPlugin(dependencies, true)],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  }
})
