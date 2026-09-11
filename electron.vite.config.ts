import { defineConfig, externalizeDepsPlugin, type UserConfig } from 'electron-vite'
import { resolve } from 'node:path'

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
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'windows-menu': resolve('src/preload/windows-menu.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  }
})
