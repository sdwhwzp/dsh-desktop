# 连接 30 的桌面客户端

此 fork 的 `dev` 分支新增远程桌面客户端，连接现有 30 服务器。原有网页、账号、会话、插件、文件夹管理、SSH 和运行服务继续保留，网页可独立使用；桌面端不是这些功能的替代入口，也不会停止服务器上的业务进程。

## 使用

1. 打开 **Tizhi AI Desktop**，填写管理员提供的服务器地址并点击连接。首次启动两个地址均为空，不自动访问任何业务服务器；目录连接地址可留空，配对时采用服务器配置。填写的设置只保存在本机。
2. 在原有网页登录页面输入账号和密码。普通账号与管理员均可登录，权限由 30 的现有账号系统判断。
3. 点击窗口顶部 **本机目录 → 选择本机目录**，在系统选择器中选择允许当前账号读写的目录。
4. 连接成功后点击 **返回会话**，在 30 的工作区列表选择对应本机工作区；Agent 可以读写文件，并在该电脑执行 Git、安装依赖和构建命令。Windows 使用 PowerShell，macOS 使用 Bash；无需手动添加 `--allow-shell`。
5. 在 **本机目录** 页面查看连接状态、断开、重新连接或移除接入。断开和移除不会删除本机文件。

目录按服务器地址和账号编号隔离。退出账号、登录过期、切换账号或关闭桌面客户端会停止本机目录访问。重新登录原账号后恢复其已启用目录；普通网络中断会自动重连。桌面端不会替其他账号连接目录。

Windows 和 Mac 桌面包默认启用本机 Shell，新配对和已有目录重连均向服务器声明此能力。命令以启动桌面端的系统用户身份执行；初始工作目录属于所选目录，命令本身可访问该系统用户有权限访问的其他路径。系统管理员/root 权限及 macOS 受保护目录访问仍由操作系统授权，不通过关闭远程网页沙箱取得。独立的 Office 自动化工具暂未接入。Agent 在 30 个人工作区执行终端命令的现有功能仍然保留；关闭桌面端不会停止 30 上托管的测试服务。

目录服务端口与网页端口分开。若网页可以登录但目录无法连接，请核对 **本机目录** 页面的目录连接地址及端口映射；留空时采用服务器下发的配置。HTTPS 服务器必须搭配 WSS，不自动降级。

## 开发与打包

```sh
npm ci
npm run dev:remote
npm run typecheck
npm test -- test/remote-desktop.test.ts
npm run build:remote
npm run package:remote:dir
```

`npm run dev:remote` 构建后运行远程客户端；原有 `npm run dev`、`npm run build` 和本地 Harness 启动代码保持原用途。两种构建共用 `out/`，切换模式前运行对应构建命令。

原生分发命令：Apple Silicon Mac 使用 `npm run package:remote:mac:arm64`；Windows x64 主机使用 `npm run package:remote:win`。不把 macOS 打出的 Windows 包视为已验证的安装包。构建输出位于 `dist/remote/`。远程包使用独立应用标识 `cn.tzwl.ai.desktop`，不读取原作者桌面端的更新源；无签名的本地包不是正式签名发行版。

## 数据与权限

登录密码直接提交到 30 的登录表单，远程页面不加载桌面 preload，不具备 Node 或目录选择 IPC。原生管理页独立运行，IPC 只接受该窗口的主框架和精确的本地页面地址。远程网页中的普通外链交给默认浏览器。

Electron 的应用数据目录 `tizhi-ai-desktop` 保存服务器设置、按服务器隔离的登录 Cookie 和经系统密钥存储加密的目录授权。密钥存储不可用时拒绝明文保存目录凭据。目录访问凭据不发送到网页或本地管理页面。

每次文件或终端操作重新验证当前账号，并在独立的本机进程执行。文件路径和终端的初始工作目录只接受授权目录内的相对路径，拒绝目录外的符号链接。文件操作最多运行 30 秒；终端默认 120 秒，可由调用设置为最多 600 秒。取消、断开、退出账号和应用退出会请求停止正在运行的命令及其子进程，应用退出等待本机执行进程收尾。该终端是单次命令接口，后台开发服务的持久托管需要单独的服务管理能力；30 上已有的持久服务不受影响。

文件进程复用 dsh-passwords 的源码，保留其实际 LICENSE 中的 GPL 文本及变更记录，参见 [companion source](../vendor/local-workspace/README.md)。远程包包含对应源文件与许可。

旧版客户端保留原服务器设置。切换服务器或从 HTTP 改用 HTTPS 时，在 **本机目录** 页面修改两个地址，重新登录并选择需要接入的本机目录。服务器地址参与目录授权隔离。

## Windows 构建验证

`dev` 的远程客户端代码变更会触发 `Remote desktop Windows installer` Actions 流程，使用 Windows x64 主机打包 NSIS 安装程序。流程静默安装到独立临时目录，再运行真实 Electron 客户端，验证登录、网页隔离、本机文件读写、Git 分支切换、终端超时及取消、账号切换与重启恢复；测试使用本机模拟服务器，不连接 30 或使用线上账号。

通过后的构件 `tizhi-ai-desktop-windows-x64` 包含安装程序、源码提交、SHA-256 与验证结果，保留 30 天。这是未签名的远程客户端构建；macOS 正式分发需要 Developer ID Application 证书和 Apple 公证，网站 HTTPS 证书不能用于应用签名。

## Mac 签名与公证

在 Xcode 的 Apple 账号设置中选择有证书权限的付费团队，通过 **Manage Certificates → Developer ID Application** 创建分发证书。证书与私钥保存在构建机钥匙串中；`security find-identity -v -p codesigning` 必须能找到有效的 Developer ID Application 身份。

在 Apple 账号网页生成此应用的专用密码，然后在终端安全提示中输入一次，保存为公证配置；不要将密码放到命令参数、源码或部署包中：

```sh
xcrun notarytool store-credentials dsh-desktop-notary --apple-id YOUR_APPLE_ID --team-id YOUR_TEAM_ID
```

构建时通过钥匙串配置提交公证，并强制要求有效签名。`CSC_NAME` 使用证书中的名称和团队编号，省略 `Developer ID Application:` 前缀：

```sh
CSC_NAME='Your Name (TEAMID)' APPLE_KEYCHAIN_PROFILE=dsh-desktop-notary \
  npm run package:remote:mac:arm64 -- --config.forceCodeSigning=true --config.dmg.sign=true
```

Electron Builder 会为应用签名、提交公证并附加票据，再生成 DMG 和 ZIP。若单独用 `notarytool` 公证应用 ZIP，应先给 `.app` 附加票据，再生成最终安装包；DMG 另外提交公证并附加票据。所有发布构件必须记录 Apple 返回的 `Accepted` 状态、SHA-256，以及 `codesign --verify --deep --strict`、`spctl --assess` 和 `xcrun stapler validate` 的结果，并运行 `scripts/remote-package-smoke.mjs` 验证实际签名应用。Apple 尚在处理、签名无效或测试失败时不能标记为已公证版本。

公证配置和分发私钥是后续发布所需凭据，不属于测试清理内容。线上安装包与哈希验证通过后，清理本次临时应用、上传 ZIP、构建包和测试日志，保留源码、验证摘要和必要回滚资料。

## 桌面终端能力修复（2026-09-11）

旧安装包在配对、操作白名单和执行进程三处禁用了 Shell，因此会话提示添加 `--allow-shell`，但桌面 UI 没有对应参数入口。升级包含本修复的安装包后，打开桌面端并恢复已接入目录，服务器会更新能力状态；随后回到该本机工作区发送新指令。旧会话记录中的拒绝文本不会被改写。

## 应用图标

桌面程序和安装包使用用户提供的蓝色梯智图标，原始 PNG 保存在 `build/app-icon.png`；Mac ICNS 和 Windows 多尺寸 ICO 由 `node scripts/generate-app-icons.mjs` 在 macOS 上生成并提交，Windows 构建直接使用提交的 ICO。原生管理页使用同一 PNG。替换图标后必须重新打包并为 Mac 重新签名、公证。
