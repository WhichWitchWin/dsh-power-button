# dsh-power-button 维护指南

> **这是仓库副本（云端备份）。** 活的、可检索的那份在 Mnemon Documents：文档 id `4eae0cca-279b-4e20-adfd-aca0724df20c`，标题《dsh-power-button 插件维护指南（DSH 桌面版电源按钮）》。
> 同步方向：**先改 Mnemon 档案，再把正文同步到本文件**（本文件不反向改档案）。
> 路径约定：`<repo>` = 本插件仓库根；`<workspace>` = 它所在的工作区目录；`%USERPROFILE%` / `%LOCALAPPDATA%` = 运行者自己的用户目录。正文里的绝对路径仅为示意，换台机器按同样规则替换即可。
> 快照时间：2026-10-08（0.1.0 刚发布到 npm 时）。

所有结论均来自实测、注册表核对或仓库内文件；没有猜测。整理于 2026-10-08（当时 0.1.0 刚发布到 npm）。

## 一、一分钟速览

| 项 | 值 |
| --- | --- |
| 本地路径 | `<repo>`（2026-10-08 从 `dsh-restart-button` 改名而来） |
| GitHub | `https://github.com/WhichWitchWin/dsh-power-button`，public，默认分支 `main`，MIT |
| npm | `dsh-power-button@0.1.0`，2026-10-08 发布，维护者 `whichwitchwin` |
| profile 安装 | `%USERPROFILE%\.dsh\profiles\desktop` 的 `package.json`：`"dsh-power-button": "link:<repo>"`，并在 `dsh.profile.bundles` 里 |
| 依赖 | 无 npm 运行时依赖；`peerDependencies: {"@deepseek-ai/dsh": ">=0.2.0-rc.2"}` |
| 平台 | 仅 Windows（taskkill + WMI + 系统自带 Windows PowerShell 5.1） |
| 深挖入口 | 仓库内 `docs/DESIGN.md`（1301 行中文工程笔记，每个反直觉决定都有取证与实测数据） |

## 二、这个插件是什么

给 DSH 桌面版补两个电源入口，各自可单独开关：

- **悬浮按钮**：可拖动；贴到左右边缘收成一条细边，悬停重新展开；点击弹出「重启 DSH / 退出 DSH」菜单。
- **侧栏电源**：坐在侧栏头像行、头像左边，与官方图标按钮同形，同一个菜单。

动机：DSH 桌面版没有界内重启入口（托盘的重启只在开发构建下出现，发布版只能先退出再从开始菜单打开）。

## 三、文件与职责

| 文件 | 作用 |
| --- | --- |
| `lib/index.js`（宿主半，ESM，约 32 KB） | 三条 loopback 路由 `/api/dsh-restart/{status,action,config}`、桌面拓扑探测、启动并等待引导进程 |
| `lib/client.js`（浏览器半，经典脚本，约 150 KB） | `window.__ModuleLoader__.load({id,factory})`；悬浮控件（拖动/贴边/悬停展开/果冻反馈）、侧栏电源、配置页两个开关、全部 CSS 与关键帧 |
| `lib/restart-helper.ps1`（约 44 KB） | 两阶段辅助：引导阶段用 WMI 重建自身为脱离进程树的工作进程；工作阶段读命令行、问端口、杀树、等端口释放、按原参数重启、把新窗口置前 |
| `cordis.patch.yml` | 一行 patch：`id: ui-restart-button`、`name: 'dsh-power-button'`、可选 `config`（`settleMs` 默认 500、`waitForExitSeconds` 默认 20） |
| `package.json` | `files` 白名单：lib / cordis.patch.yml / 两份 README / docs / LICENSE / icon.svg；无构建脚本 |
| `README.md` / `README.en.md` | 中文优先，顶部徽章行 + 中英互链；含「前言」（AI 参与声明）与「小果冻」动画小节 |
| `docs/DESIGN.md` | 工程笔记（改代码前必读） |
| `docs/MAINTENANCE.md` | 本文件：维护指南的仓库副本（云端备份），活的版本在 Mnemon Documents |
| `.gitignore` | 忽略 `backups/`、`release/`、`*.zip`、`*.tgz`、`node_modules/` 等 |
| `backups/`（不进仓库） | 历次改动前的源码/发布物归档、profile 配置备份、`pre-emailfix-*.txt` 等记录 |
| `release/`（不进仓库） | `dsh-power-button-0.1.0.zip` + `.tgz`，与发布 0.1.0 时的仓库逐字节一致，作为 GitHub Release 附件用 |

**没有构建步骤**：`lib/` 既是源码也是产物，包内无 `src/`、无中间产物。profile 用 `link:` 安装时，`node_modules/dsh-power-button` 是指向源码目录的链接，改完保存即热重载（没反应就刷新页面）。

## 四、绝对不能"顺手改"的取舍（改前必读 DESIGN.md 对应段）

1. **侧栏重排只由本插件自己的 `data-dshrb-inrow` 武装**。不要按别的插件的标记有无分支判断：`data-dsh-frame` 是 `@linxin666/*` 单向写入、从不移除的门闩，web-all 关掉后标记仍在，以"标记消失"为条件的兜底分支会永久失效（按钮独占一行）。
2. **按钮与菜单背景写死不透明**（用不透明的 `--dsw-alias-bg-layer-1`），**不跟随**宿主的菜单透明度设置 `--dsw-specific-menu`（它含 alpha，实测 `#f8f9fa94`/`#43454a73`）；颜色仍需跟随主题亮/暗。这是用户的明确要求。
3. **动画的数字互相咬着**：`dshrb-jelly` 关键帧 `.46s` 与 JS 常量 `JELLY_MS = 520` 必须满足"按下类活得比动画久"，否则 `transform` 中途跳回；展开动画是**一次性**的（在上升沿武装，被这次展开期间的第一次按压永久解除）。两侧时长有意不同（悬浮 `.46s`、侧栏 `.52s`）。
4. **重启必须由 WMI 创建的、脱离进程树的进程执行**：宿主进程是 Electron 主进程的子进程，`spawn(detached)` 仍会被 `taskkill /T` 连带杀掉，只有 `Win32_Process.Create` 创建的子进程能在创建者退出后活下来。
5. **三条路由注册为 `exact`，会先于宿主 `/api` 前缀表派发并遮蔽其鉴权**，所以必须自己调用 `requestRejection`（Host/Origin fence + 浏览器鉴权 cookie），并额外要求 socket 远程地址是回环、`Host` 头是回环权威；`X-Forwarded-For` 从不采信；请求体上限 4 KiB。
6. **侧栏落点依赖 `:has()` 与外壳 class 后缀**（`footArea`/`footerActions`/`settingsArea`）；不支持 `:has()` 时这段重排整体失效，退化成外壳自己的堆叠布局（与本插件出现前一样，不会更糟）。悬浮按钮与该依赖无关。
7. **侧栏「头像行」没有第三方扩展位**：`sidebar.settings` 与 `settings.launcher` 都是 `kind="single"`（后者在 `triggerRow` 内部，官方账号按钮正是它的 fallback），`SlotOutlet` 宿主容器是 `display:contents`，非折叠态 `settingsArea` 是 block。想让控件与头像同行，只能改造 `footArea` 布局。

### 刻意保留的旧名字（改名会丢用户数据或毫无意义）

| 保留项 | 原因 |
| --- | --- |
| `var POS_KEY = "dsh-restart-button:pos:v1"`（`lib/client.js` 约 79 行） | 里面存着用户拖好的悬浮位置，改键名等于把位置重置 |
| 路由 `/api/dsh-restart/{status,action,config}` | 对外契约，改了没收益 |
| 日志 `restart-button.log`、拒绝标记 `restart-button.refused` | 排障文档与用户习惯 |
| DOM 标记 `data-dsh-plugin="restart-button"`、`data-dsh-restart-root` | 同上 |
| CSS 前缀 `dshrb-` | 同上 |
| patch 行 `id: ui-restart-button` | profile 里已存在的覆盖项按 id 匹配 |

配置文件**已改名**为 `dsh-power-button.json`（旧 `dsh-restart-button.json` 被忽略，两个开关默认开启，所以没有可见变化）。

## 五、验证栈（多层叠加，缺一层都会漏）

脚本放在 `%TEMP%\dshrb-test\`（临时目录会被系统清理，丢了按此说明重建；核心是"静态 / 行为 / 真实宿主 / 变异 / 产物"五层）：

| 脚本 | 作用 | 上次结果（2026-10-08） |
| --- | --- | --- |
| `check.mjs <repo>` | 静态解析 + 契约断言（浏览器半用 `vm.Script` 只解析不执行） | 176 OK / 0 FAIL |
| `behaviour.mjs <repo>` | 行为断言（**看不到 CSS 布局**） | 157 OK / 0 FAIL |
| `routes.mjs` | 起真实宿主测三条路由 | 20/20 |
| `neg.mjs` + `run-all-mutations.ps1` | 51 个变异体，全部必须被 CAUGHT | 51/51 |
| `verify-release.py` | `release/` 的 zip+tgz 与发布 0.1.0 时的仓库逐字节比对 | 10/10 一致 |
| `verify-pack.py <tarball>` | 任意打包产物与仓库比对（核对 npm 上那一版就用它） | — |

运行要点：本机无系统 node，用真 node 直接跑即可捕获输出；Electron-as-node 跑脚本时 PowerShell **抓不到 stdout**，要 `cmd /c "... > file 2>&1"`。

> 注：仓库在 0.1.0 之后继续前进（例如新增本文件），`release/` 里的包仍是 0.1.0 的历史快照，`verify-release.py` 此时会如实报出差异——这是预期行为，不要为了它去重建历史包。

## 六、发布流程

### npm

```powershell
cd '<repo>'
& '%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' `
  '%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs' `
  publish --access public --no-git-checks
```

- **必须用真 node + 普通交互窗口**：Electron-as-node 没有 TTY，会报 `ERR_PNPM_LOGIN_NON_INTERACTIVE` / `ERR_PNPM_OTP_NON_INTERACTIVE`。
- 凭据在 `%LOCALAPPDATA%\pnpm\config\auth.ini`（**不是** `~/.npmrc`；pnpm 11 把全局凭据写这里，`~/.npmrc` 从来不会生成）。
- 发布需要 OTP（验证码由用户输入）。**新包名首发会进 npm 审核**：registry 先挂一个 `0.0.0-stage` 占位版撑住名字，审核通过后才放出真版本（0.1.0 实测：占位版 12:15:54Z → 真版本 12:20:08Z）。新版本是否会再次审核未知。
- 同一 `名字@版本号` 不能重复发布，要更新包内容/文档只能发新版本号。
- **npm 页面显示的 README 来自那一版 tarball 里的 `README.md`**（registry 的 `readme` 字段是空的，但不影响页面渲染）。所以要更新包页文档 = 发新版本。
- 发布后核对：`curl.exe -sSL -o published.tgz https://registry.npmjs.org/dsh-power-button/-/dsh-power-button-<ver>.tgz`，比对注册表声明的 `dist.shasum` 与自己算出的 sha1，再用 `verify-pack.py` 逐字节比对仓库。
- 已知遗留：包页 README 落后 GitHub 一版（缺 npm 安装章节与 npm 徽章）；2026-10-08 用户决定**暂不发 0.1.1**。

### GitHub

- 直连 GitHub 会被重置，仓库本地 `.git/config` 已设 `http.proxy=http://127.0.0.1:7897` 与 `http.sslBackend=openssl`，所以直接 `git push` 即可（代理是运行者机器的本地代理）。
- 提交身份是 repo-local 的 `WhichWitchWin` / `WhichWitchWin@users.noreply.github.com`（2026-10-08 用 `git filter-branch --env-filter` 把 `Initial commit` 的 qq 邮箱也换掉了；改写前历史备份在 `refs/original/*`，改动记录在 `backups/pre-emailfix-*.txt`）。
- 发布物（zip/tgz）按 `.gitignore` 不进仓库，作为 GitHub Release 附件上传。

## 七、本机环境要点（这台机器专属）

- **没有系统 node/npm/pnpm/gh/7z**。真 node：`…\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（v24.21.0）；pnpm：同目录 `pnpm\bin\pnpm.mjs`（11.7.0）；python：同目录 `python\python.exe`。
- DSH CLI：`D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`（桌面版入口，带 `manageDesktopProfile`；PATH 里随便一个 `dsh` 会以 `profile "desktop" is managed exclusively by the Electron application` 拒绝）。
- **`dsh plugin --profile <p> <args>` 只是把参数原样转发给 pnpm，不维护 `dsh.profile.bundles`**。装/卸插件请走插件管理器 UI，或手工同时改 `package.json` 的 `dependencies` 与 `dsh.profile.bundles`，再跑 `plugin install`。只跑 pnpm remove/add 会让 bundles 列表与实现不一致。
- Electron-as-node（`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1`）是 GUI 子系统：没有 TTY，也抓不到 stdout（要 `cmd /c "... > file 2>&1"`）。
- Windows PowerShell 5.1：不支持 `??`；`Get-Content` 对**无 BOM 的 UTF-8 会按 ANSI 解码**（中文比较要显式 `-Encoding UTF8`）；`Set-Content -Encoding utf8` 会加 BOM，需要无 BOM 时用 `[System.IO.File]::WriteAllText`。
- 工作区根：`<workspace>`。硬规则：**绝不删除文件**（回收站可以），改动前的原件归档到包内 `backups/`。
- 插件管理器的「检查更新」**只对比 npm registry 直装的包**（`check-updates` 要求 `source.kind === "npm"` 且是直接 registry 规格）；`github:` 与本地路径都会被跳过。

## 八、已知边界（对用户诚实清单）

只支持 Windows；WMI 被禁用或被安全软件拦截时引导阶段失败并显示原因（不静默）；会硬中断进行中的会话（有任务在跑时二次确认，空闲直接执行）；重启不恢复界面状态；`dsh web` 终止模式下两个界面都隐藏且 `supported: false`；新窗口尽力置前但不保证抢到键盘焦点；无法在头像菜单里插「重启」行（行是硬编码数组）；侧栏落点依赖 `:has()`。

## 九、待办 / 下一步

1. 用户手点：GitHub 仓库 About 的 **Website** 填 `https://www.npmjs.com/package/dsh-power-button`（没有 API token，需要用户操作）。
2. 可选：给 `v0.1.0` 建 GitHub Release，把 `release/` 里 zip + tgz 传为附件。
3. 可选：把 profile 依赖从 `link:` 换成 npm 名（`plugin remove dsh-power-button` + `plugin add dsh-power-button`）——只有 registry 直装才能被检查更新认出来；但换掉 link 就失去热重载，开发期建议保持 `link:`。
4. 可选：发 `0.1.1` 让 npm 页面的 README 与 GitHub 同步（当前决定：暂不发）。
5. 讨论过但未实现：`turn/end` 就绪门、另一会话运行中的守卫、页面刷新入口、模型可调用的重启工具。

## 十、常用核对命令片段

```powershell
# 注册表状态
curl.exe -s https://registry.npmjs.org/dsh-power-button/latest
# 或：pnpm view dsh-power-button version dist-tags

# 下载并核对 npm 上的那一版
curl.exe -sSL -o published.tgz https://registry.npmjs.org/dsh-power-button/-/dsh-power-button-0.1.0.tgz
& '…\python.exe' "$env:TEMP\dshrb-test\verify-pack.py" published.tgz

# 本地验证
& '…\node.exe' "$env:TEMP\dshrb-test\check.mjs" '<repo>'
& '…\node.exe' "$env:TEMP\dshrb-test\behaviour.mjs" '<repo>'

# 远程文件核对（不需要 API token）
git show origin/main:README.md | Select-String '方式一：从 npm 安装'
```
