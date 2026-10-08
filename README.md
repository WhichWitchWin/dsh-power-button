# dsh-power-button

![npm version](https://img.shields.io/npm/v/dsh-power-button)
![platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![language: JavaScript](https://img.shields.io/badge/language-JavaScript-F7DF1E)
![helper: PowerShell](https://img.shields.io/badge/helper-PowerShell-5391FE)
![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen)
![license: MIT](https://img.shields.io/badge/license-MIT-blue)

**简体中文** ・ [English](README.en.md)

给 **DSH 桌面版**（DeepSeek Harness Desktop）补两个电源入口，各自可单独开关：

- **悬浮按钮** —— 可拖动；贴到左右边缘会收成一条细边，鼠标移到细边上重新展开。点击弹出
  「重启 DSH / 退出 DSH」菜单。
- **侧栏电源** —— 坐在侧栏头像行里、头像左边，与旁边的官方图标按钮同形，弹出同一个菜单。

```
拖动 → 贴边收起 → 鼠标移上去展开 → 点击 →（有任务在跑才二次确认）→ 重启 或 退出
```

DSH 桌面版本身没有界内重启入口：托盘菜单里的重启只在开发构建下出现，发布版只能先退出、
再从开始菜单重新打开。这个插件补的就是这一格。

- **只支持 Windows**：依赖 `taskkill`、WMI 与系统自带的 Windows PowerShell 5.1。
- **零依赖**：纯 JS，不 import 任何 Harness 客户端包。
- **不读别的插件的 DOM 或样式**：两个落点都走官方槽位；侧栏图标的位置也不依赖其他插件
  （装了 `@linxin666/dsh-web-all` 时落在同一位置）。

---

## 前言

本插件由 **DeepSeek Harness Desktop + DeepSeek v4.1 flash** 制作：代码和这两份 README 都是模型
写的，人工只参与了调试与审阅。它属于 **vibe code 产物**——每个反直觉的实现都在
`docs/DESIGN.md` 里留了取证与实测数据，但请按"别人家 AI 养大的项目"来对待：上手前先看
「已知边界」，遇到问题欢迎提 issue。

---

## 安装

安装会改动 profile 的 `package.json` 与 `pnpm-lock.yaml`，先备份：

```powershell
Copy-Item "$env:DSH_HOME\profiles\desktop\package.json" `
  "$env:DSH_HOME\profiles\desktop\package.json.bak" -Force
```

### 方式一：从 npm 安装（推荐）

```powershell
& 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
  plugin --profile desktop add dsh-power-button
```

装的是注册表上的正式版本（当前 `0.1.0`）。**只有这种装法会被插件管理器的「检查更新」
认出来**——它只对 npm registry 直装的包做版本比对，`github:` 规格和本地路径都会被跳过。

### 方式二：本地目录

```powershell
git clone https://github.com/WhichWitchWin/dsh-power-button.git
& 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
  plugin --profile desktop add 'D:\path\to\dsh-power-button'
```

### 方式三：从 GitHub 直接装

```powershell
& 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
  plugin --profile desktop add 'github:WhichWitchWin/dsh-power-button#main'
```

（`#main` 是 git 引用，换成别的分支 / tag / commit 也行；整段删掉就取默认分支。）

三种方式都会把依赖写进 profile 的 `package.json`，并把本包加进 `dsh.profile.bundles`
（`dsh.bundle.patch` 一声明即激活）。**装完重启一次 DSH**（托盘退出再打开），两个界面就会
出现。`lib/` 是可直接加载的成品，没有构建步骤，包内不含 `src/`、`node_modules/` 或中间产物。

> CLI 路径以你的实际安装目录为准，并且**必须用桌面版自带的这个入口**：它给 profile
> `desktop` 开了 `manageDesktopProfile`；`PATH` 里随便一个 `dsh` 会以
> `profile "desktop" is managed exclusively by the Electron application` 拒绝。
> 装到别的 profile 时把 `--profile` 换成那个名字即可。

### 卸载

```powershell
& 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
  plugin --profile desktop remove dsh-power-button
```

---

## 使用

| 操作 | 结果 |
| --- | --- |
| 拖动悬浮按钮 | 移动位置；松手时靠近左右边缘会吸附并收起 |
| 鼠标移到细边上 | 展开成完整按钮（移开即收回） |
| 点击按钮 | 弹出电源菜单 |
| 点击菜单外的空白 | 关闭菜单，控件回到细条（不会常驻展开） |
| `Esc` | 关闭菜单 |
| `Enter` / `Space` | 等价于点击按钮 |

- **上下边缘故意不作吸附目标**：那里有窗口控件和输入框，一条边会盖住两者。
- 悬浮位置存在浏览器 `localStorage`。
- **二次确认只在真有任务在跑时才问**：宿主报告有 agent 正在运行（子代理也算）时才弹确认，
  因为那正是点击会毁掉用户拿不回来的工作的场景；空闲时直接执行，不给常见路径加摩擦。
  宿主无法作答时按"有任务"处理。

### 按下去像一块小果冻 🍮

两个按钮都会"捏"：

- **按下**：被横向挤扁、纵向拉长一点点（`scale(.9, 1.1)`，0.16s），顺手挤出几颗 7px 的小
  水珠，顺着你按压的方向甩出去、边飞边缩小淡掉。
- **松手**：像果冻那样弹回来——横向先过冲 +12%、再缩到 −6%、再回到 +4%，纵向同时反向镜像
  地晃，两三下之后才稳稳停住（悬浮 0.46s，侧栏 0.52s）。
- **从细边钻出来**：不是"啪"地出现，而是从半宽滑出来（`scale(.5,1)` 且透明），落位时轻轻
  弹几下（0.44s）。

所以它不只是"能用"：按住有肉感，松手有回弹，贴边之后探出来也软软的。
（时长和曲线是实测调过的——改之前先看 `docs/DESIGN.md`，那里面的数字互相咬着。）

### 两个界面分开开关

插件管理器里本插件自己的配置页上有两个开关：**悬浮电源按钮** / **侧栏底部电源图标**。
插件卡片上的开关管的是整个包，这两个管的是各自的界面，改动即时生效、无需刷新。

---

## 配置

界面开关存在 profile 目录下的 `dsh-power-button.json`，由配置页写入：

```json
{ "floating": true, "sidebar": true }
```

宿主半另有一个可选 `config` 块，两个与机器性能相关的**上限**（默认值适合普通机器）：

| 键 | 默认 | 范围 | 含义 |
| --- | --- | --- | --- |
| `settleMs` | `500` | 0–30000 | 杀进程前留给 HTTP 响应抵达浏览器的时间 |
| `waitForExitSeconds` | `20` | 1–300 | 等待旧壳真正消失的上限 |

端口一释放就立刻继续，所以这两个值通常不会被等满。慢机器或高负载机器上如果日志出现
`WARNING: proceeding after ...s`，就把它调大。加在 profile 的 bundle patch 里：

```yaml
- insert:
    - id: ui-restart-button
      name: 'dsh-power-button'
      config:
        settleMs: 800
        waitForExitSeconds: 30
```

---

## 它怎么做到的

桌面版的重启由 Electron 主进程持有（`app.relaunch()` + `app.quit()`），但没有把这条能力开给
插件，所以插件只能从外部**复刻**一次重启。这里有个先有鸡还是先有蛋的约束：**宿主进程是
Electron 主进程的子进程**，杀掉主进程会连带杀掉宿主，下杀手的那段代码不能待在宿主进程里。
于是工作交给一个**脱离进程树**的 PowerShell 辅助进程：

```
点击「重启 DSH」→ 二次确认
      ↓
宿主半 POST /api/dsh-restart/action { action: "restart" }
      ↓
宿主半同步等待 lib/restart-helper.ps1 的「引导阶段」返回
      ↓
引导阶段用 Win32_Process.Create (WMI) 把自己重建为「工作阶段」，然后退出
      ↓
工作进程（父进程是 WmiPrvSE，不在应用进程树里，taskkill 够不到它）：
  1. 记下起始时刻与 settleMs 的截止时刻
  2. 趁主进程还活着，读它自己的命令行      ← 复刻 app.relaunch() 的语义
  3. 趁宿主还活着，问出它监听的端口与绑定的地址（IPv4 / IPv6 都覆盖）
  4. 杀旧进程树，等它彻底消失
  5. 等端口释放（以 bind 那个地址判定）
  6. 按原参数拉起新实例（并交接 DSH_* 环境变量）
  7. 轮询新实例的窗口并置前，避免被别的程序遮住
```

`detached: true` 的 `spawn` 不够：子进程仍以本进程为父，`taskkill /T` 会连它一起杀掉；
**只有 WMI 创建的子进程**既脱离进程树、又能在创建者退出后活下来。

「退出」走 `taskkill`：宿主进程一退出，这个壳会把它的退出码一律当致命错误处理，这条路上
没有更优雅的实现。

---

## 安全护栏

三条路由都在 Host 源下，且必须自己调用 `requestRejection`——它们注册为 `exact` 路由，会先于
Host 的 `/api` 前缀表被派发，因此会遮蔽 Host 给其他 `/api` 端点加的身份验证。插件主动复用
Host 自己的授权判断（Host/Origin fence + 浏览器鉴权 cookie），待在同一个权限模型里。

- 另外两道独立围栏：socket 远程地址必须是回环（127/8、`::1`、IPv4-mapped），`Host` 头也必须
  是回环权威。`X-Forwarded-For` 从不采信，`sec-fetch-site: cross-site` 直接拒。
- 请求体上限 4 KiB，超限即拒（不是先缓冲再看大小）。
- 破坏性动作是**一次性闸门**：接受过一次就不再放开，因为进程本来就要消失；只有"根本没启动
  起来"（spawn 失败 / 引导超时 / 辅助进程的退出码 3）才释放，那种情况下重试才有意义。
- 退出码 3 与拒绝标记文件区分"没动手就拒绝"（可安全重试）与"动手中途失败"（此时可能已经杀过
  树，绝不放开闸门重来）。工作阶段的拒绝由辅助进程写标记文件，用户下次点击时读取。

---

## 排障

日志在 DSH 的 logs 目录下：`restart-button.log`（拒绝标记 `restart-button.refused`）。
这个目录按 `$DSH_HOME\logs` → 从宿主自己的 profile 参数反推 → `%TEMP%` 的顺序解析，
所以 `DSH_HOME` 不是 `~/.dsh` 时，日志在它实际指向的地方。

---

## 已知边界

- **只支持 Windows。** 依赖 `taskkill`、`Win32_Process.Create`（WMI）与
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`；macOS / Linux 返回
  `supported: false` 并隐藏界面。
- **需要 WMI 可用。** 被禁用或被安全软件拦截时引导阶段失败，界面显示失败原因，不会静默。
- **会硬中断进行中的会话。** 这是强杀的固有代价；有任务在跑时确认框会明确提示。
- **重启不保证恢复界面状态。** 等价于"退出再打开"：未提交的输入不保留，进行中的回合不会
  自动继续。
- **终止模式（`dsh web`）下两个界面都不出现。** 那里没有可复刻的重启语义，插件回答
  `supported: false` 并整体隐藏，而不是留一个点了没用的按钮。
- **新窗口会尽力置前，但不保证抢到键盘焦点。** Windows 的前台锁让非前台进程无法夺取焦点，
  所以窗口会被抬到最前，但你可能要再点一下才能输入。
- **无法在头像菜单里插「重启」行。** 那个菜单的行是硬编码数组，没有菜单行槽位。
- **侧栏落点依赖 `:has()` 与外壳的 class 后缀**（`footArea` / `footerActions` /
  `settingsArea`）；不支持 `:has()` 时这段重排整体失效，退化成外壳自己的堆叠布局，
  与本插件出现之前一样，不会更糟。悬浮按钮与此无关。

---

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半：三条 loopback 路由（status / action / config）、桌面拓扑探测、启动并等待引导进程 |
| `lib/restart-helper.ps1` | 两阶段辅助：引导阶段用 WMI 重建工作进程；工作阶段读命令行、问端口、杀树、等条件、按原参数重启、把新窗口置前 |
| `lib/client.js` | 浏览器半：悬浮控件（拖动 / 贴边 / 悬停展开 / 果冻反馈）、侧栏电源、配置页两个开关 |
| `cordis.patch.yml` | bundle patch：一个宿主行；浏览器半由 `dsh.client` 自动挂载 |
| `docs/DESIGN.md` | 工程笔记（中文）：每个反直觉决定的取证与实测数据 |
| `LICENSE` | MIT |

## 开发（仅二次开发需要看）

`lib/` 是直接加载的成品，改完在界面上热重载即可看到效果（profile 以 `link:` 方式安装时，
源码改动不需要重装）。改代码前建议先读 `docs/DESIGN.md`，它记录了那些看起来可以简化、
实际上会炸的地方。

## License

MIT

---

## 友情链接

- [LINUX DO](https://linux.do)
