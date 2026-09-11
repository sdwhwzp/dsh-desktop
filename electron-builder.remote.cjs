/** Separate distribution identity; never consumes upstream desktop update feeds. */
module.exports = {
  appId: 'cn.tzwl.ai.desktop', productName: 'Tizhi AI Desktop',
  asar: false, npmRebuild: false, electronVersion: require('./package.json').devDependencies.electron,
  directories: { app: 'dist/remote-app', output: 'dist/remote', buildResources: 'build' },
  files: ['out/**/*', 'node_modules/ws/**/*', 'package.json', 'LICENSE', '!**/*.map'],
  extraResources: [
    { from: 'vendor/local-workspace', to: 'local-workspace-source' },
    { from: 'src/main/remote/filesystem-worker.ts', to: 'local-workspace-source/filesystem-worker.ts' },
    { from: 'electron.vite.config.ts', to: 'local-workspace-source/electron.vite.config.ts' }
  ],
  extraMetadata: { name: 'tizhi-ai-desktop', dependencies: { ws: '^8.21.3' } },
  publish: null, artifactName: 'tizhi-ai-desktop-${os}-${arch}.${ext}',
  mac: { category: 'public.app-category.productivity', icon: 'build/icon.icns', target: ['dmg', 'zip'] },
  win: { icon: 'build/icon.ico', target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true }
}
