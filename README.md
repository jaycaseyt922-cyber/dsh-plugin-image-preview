# dsh-plugin-image-preview

> **English** — Preview local images inside a [DeepSeek Harness](https://github.com/deepseek-ai) conversation, without leaving the chat: absolute image paths in prose grow a thumbnail (a path alone on its line becomes a full inline preview), a `preview_image` tool card shows a gallery, and a full-screen viewer zooms, pans, pages between images and copies the current one to the clipboard as PNG. The pictures themselves never enter the model context — only a short text envelope of paths and sizes does.
>
> ```sh
> # install into a harness profile (see "安装" below for the file: / junction caveat)
> dsh plugin add dsh-plugin-image-preview
> ```
> MIT licensed. Requires a Harness build that exposes the `tool.call.toolview` client slot and `ctx.webServer`.

会话里直接看本地图片：模型自己画的示意图、切出来的题图、渲染好的页面，不用离开会话去资源管理器里翻。

装好之后有四件事会变：

1. **正文里的图片路径旁边直接出现缩略图。** 助手回复、工具输出里出现 `C:\Users\me\fig1.png` 这样的绝对路径时，路径文字原样保留，紧跟着长出一枚 46×34 的缩略图；**路径独占一行时直接渲染成一整块预览图**（最大 560×320，底下标尺寸）。历史消息、流式输出都生效，不需要模型配合。
2. **鼠标停在缩略图上就出大图。** 不用点：悬停 220ms 弹出浮动预览（最大 340×280），移开或滚动即消失。
3. **`preview_image` 工具卡。** 模型生成图之后调一次 `preview_image`，会话里就会出现一张缩略图网格卡（不是一行路径），点缩略图看大图。图片本身只给用户看，**不进模型上下文**；进上下文的是工具结果里那段「路径 · 类型 · 体积」文本信封（最多 24 行，几百 token）。卡片画的是**这次真的产出了什么**：宿主用 `presentationMeta` 把校验通过的那批图写进结果元数据，卡片优先读它——所以 `dir: …` 这种参数里根本没有路径的调用也能正常出图。
4. **全屏查看器。** 滚轮以光标为中心缩放、拖动平移、双击切换「适应窗口 / 原始像素」、`←`/`→` 在同一段消息的几张图之间翻页、`0` 适应、`1` 原始像素、`Esc` 关闭；**「复制」把当前图以 PNG 写进剪贴板**（`Ctrl+C` 同效；失败时退化为复制路径）；「刷新」按钮会绕开宿主的 `no-store` 缓存重新读盘，覆盖写过的图也能看到最新版本。

官方会话本来就会把 `![](C:\...\fig.png)` 渲染成内嵌缩略图（自带灯箱）。本插件补的是官方不做的那一半：**裸路径**（纯文本里的路径），以及一个按原始像素看图的查看器。

## 安装

**从 npm（推荐）**

```sh
npm install -g dsh-plugin-image-preview     # 或 pnpm add -g
dsh plugin add dsh-plugin-image-preview     # 装进当前 profile
```

**本地目录开发**（本仓库现在的用法）

包在 profile 的 `plugins/` 下，profile 里声明：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "dsh-plugin-image-preview": "file:plugins/dsh-plugin-image-preview" },
"dsh": { "profile": { "bundles": ["...", "dsh-plugin-image-preview"] } }
```

**`file:` 依赖装出来的是副本，不是软链。** 这一点踩过坑：改 `plugins/…/client.js` 之后重启应用，宿主读的还是 `node_modules/dsh-plugin-image-preview/` 里那份旧副本，界面上永远停留第一版。所以装完之后要把副本换成指向源目录的 junction：

```powershell
cmd /c rmdir /s /q "C:\Users\18373\.dsh\profiles\desktop\node_modules\dsh-plugin-image-preview"
cmd /c mklink /J "C:\Users\18373\.dsh\profiles\desktop\node_modules\dsh-plugin-image-preview" "C:\Users\18373\.dsh\profiles\desktop\plugins\dsh-plugin-image-preview"
```

（`dsh-local-doc-kit`、`dsh-local-profile-guard` 同样处理过。再跑 `pnpm install` 会把 junction 换回副本，需要重建。）

改完 `client.js`、`index.js` 后**重启一次应用**（浏览器半的 bundle 在启动时装配；桌面窗口吞掉 `Ctrl+R`，也没有 dev:web 的重建通知）。

## 用法

模型侧：`preview_image({ paths: ["C:\\...\\a.png"], caption: "示意图" })`，或 `preview_image({ dir: "C:\\...\\figs", limit: 6 })` 看目录里最新的几张。返回文本信封（路径 / 格式 / 体积）；图片由浏览器半取字节后以 `data:` URL 显示。

用户侧：点正文里的缩略图或工具卡里的缩略图。

### 取图为什么走 POST（踩坑记录）

官方 `api/file?path=…` 在本机桌面壳里**对插件请求一律 404**：`dsh-app://app/...` 转发到宿主时，查询串里的 Windows 路径会变形（宿主收到一个 `stat` 不到的值，`diag` 显示 `文件不存在`，而同一路径在宿主侧直连是 `ok=true`）。路径段（base64url）也不可靠。所以传输改成：

```
POST /image-preview/read   请求体 {"path":"C:\\…"}   Accept: application/octet-stream
→ 200 image/png + 原始字节（宿主 createReadStream 直出，不落 base64）
```

路径只在 JSON 请求体里，不过任何 URL 编码；响应是**字节流**，页面用 `response.blob()` 接住再挂成 `blob:` 对象 URL——不拼 `data:…;base64,` 巨型字符串，内存只有一份位图，用完 `revokeObjectURL`。老宿主（还在回 base64 JSON）也认，客户端按 `content-type` 分支解码。客户端按 `POST → 路径段 → 查询串 → 官方 api/file` 的顺序兜底，前一层成功就不走后面；同一个文件的字节按 `(路径, 刷新序号)` 缓存，一屏里正文 + 卡片 + 悬停 + 查看器只取一次，并发上限 3 路。

识别规则（刻意保守，避免把普通文字变成按钮）：

| 写法 | 结果 |
| --- | --- |
| `C:\dir\fig.png` · `C:/dir/fig.png` | ✅ 变成图片按钮 |
| `C:\dir\a (1).png`（含空格） | ✅ 变成图片按钮 |
| `![](C:\dir\fig.png)` | 官方直接内嵌缩略图 + 官方灯箱（插件不重复处理） |
| 反引号 `` `C:\dir\fig.png` ``、链接 `[x](…)` | 官方已经是文件按钮，插件不改写 |
| `file:///C:/x.png`、`\\server\share\x.png` | ❌ 不识别：前者渲染成链接会被跳过，后者不是盘符路径 |
| `C:/x/y.png?raw=1` | ⚠️ 会按 `C:/x/y.png` 识别（`?` 只是正则的边界，不进入路径）——取的是原图，加不加查询串结果一样 |
| `https://example.com/a.png` | ❌ 不识别（不是本地路径） |
| `10:30`、`a:b` | ❌ 不是盘符路径 |
| `code` / `pre` / `a` / `button` / 输入框 / 侧栏 | ❌ 不改写 |

**写路径请优先用正斜杠**（`C:/Users/me/fig1.png`）。Markdown 会把反斜杠当转义符：`\_`、`\(`、`\)` 会把那个反斜杠吃掉——本机实测 `Documents\_dsh_tmp\x.png` 渲染成 `Documents_dsh_tmp\x.png`，插件按渲染后的文本取图，自然 `404 文件不存在`。用正斜杠、或者把路径放进行内代码里，就绕开了。

支持 png / jpg / jpeg / webp / gif / bmp / avif，宿主半按文件头嗅探，扩展名与内容不符会拒绝并说明原因。

## 两半的分工

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | `preview_image` 工具（存在性、魔数、大小校验；`dir` 取最新；去重与超上限上报）；`output.presentationMeta` 把出图清单写进结果元数据；一段系统提示公告；五条只读/自检路由 `/image-preview/{read,file,blob,diag,client-report}`（全部先过 Host/Origin 与会话 cookie 闸门；`read` 是 POST + JSON 请求体，`file`/`blob` 直出字节，只回六种位图并按魔数判定，`no-store`） |
| Client | `client.js` | `tool.call.toolview` 的 `preview_image` 卡（优先读结果元数据，`dir` 调用也出图）；正文路径的缩略图与整块预览（MutationObserver，只追加、不切文本，自己插入的元素带 `data-ip-own`）；悬停预览；全屏查看器（缩放/平移/翻页/复制/刷新）；同一路径的字节按 `(路径, 刷新序号)` 缓存，一屏多处引用只取一次 |

**取图有三层兜底**：先试本插件自己的 `POST /image-preview/read`（路径走 JSON 请求体，避开 `dsh-app://` 代理对查询串的重编码），再试 `GET /image-preview/file`、`GET /image-preview/blob/<base64url>`，最后试宿主官方的 `api/file`；每条都用 `document.baseURI`／页面 URL／origin／`dsh-app://app/` 四种基址和路径的两种斜杠写法；`<img>` 直接取失败时改用 `fetch` 取字节转 blob 再显示。三层都失败才报错，并把 HTTP 状态、实际 URL、`baseURI` 写在屏幕上。

不开 Cordis 服务、不读别的插件的 DOM 结构（只对文本节点做原地追加，且只动自己插入的元素）。

## 自测

`test/harness.html` 是一个空壳页面，用一个假 React 和假 ctx 加载 `client.js`，覆盖：路径识别（含空格、中文标点、URL 反例）、跳过区域（code/pre/a/button/contenteditable/aside）、流式重渲染不重复、点开/翻页/Esc。

```powershell
cd <本插件目录>
node test\serve.cjs          # http://127.0.0.1:8765/test/harness.html
node --check index.js; node --check client.js
```

`serve.cjs` 顺带模拟了宿主的 `/api/file?path=`，所以自测台里图片是真能加载出来的；它**不**实现插件自己的 `/image-preview/file`，正好顺带验证「插件路由 404 → 官方路由命中」这条兜底链。

自测台覆盖不到的只有真实宿主里 `dsh-app://` 那一层，以及**工具卡**（假 React 没有 `useEffect`/`useRef`，卡片根本渲染不出来）。这两块用探针 + `test/probe-assertions.js`：它注入一段含图片路径的 DOM，然后断言「流式不重复、路径消失后原文恢复、反复重写不丢图、坏路径只失败一次、好路径仍走 `blob:`」。起探针之前请先读下一节开头的**两条硬约定**（不许弹窗、不许留在后台）。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\probe.ps1 -Start -Supervise -ExitAfter 120
node tools/cdp.mjs eval "$(Get-Content test\probe-assertions.js -Raw)"
powershell -NoProfile -ExecutionPolicy Bypass -File tools\probe.ps1 -Stop
```

## 显示位置与折叠（重要）

- **正文里的路径永远可见**：会话的「Work details」折叠只作用于**已完成回合的过程行**（工具卡、命令、推理预览），不作用于答案正文。所以把路径写进正文、让它直接渲染成缩略图/整块预览，是唯一“不会被折叠”的用法——本插件的默认建议就是这个。
- `preview_image` 的工具卡在 `compact`/`standard`/`detailed` 模式下会被折进「已完成，用时 N 秒」，需要展开才看到；`verbose` 模式不折叠（但会让**所有**过程行常显，噪音大）。官方没有“只豁免图片卡”的开关。
- 想要“回合末尾常显的图片带”，只能再注册 `conversation.chat.turnTail`（折叠之外），它只给 `{ turn, seq, openFile }`，要靠 `ChatNodeStore.turnDataSource` 反查该回合的图片——更贴近内部契约，暂未实现。

## 探针实例（自测手段）

改客户端插件最烦的是“只有真实窗口能验”。`tools/probe.ps1` 起一个**独立**的 Harness 实例：独立 `user-data-dir`、独立 `DSH_HOME`（配置与会话从真实 profile 拷一份）、`node_modules` 用 junction 共享，并打开 CDP 端口。

### 两条硬约定（后来者必须遵守，不是建议）

| 约定 | 机制 | 怎么验证 |
| --- | --- | --- |
| **不许出现在屏幕上** | 探针进程用 `CreateDesktop` 建一个**独立 Windows 桌面**再启动；你的桌面只合成你正在用的那个，所以窗口创建/显示/重绘全程都不可见，任务栏也不多按钮 | 用 `tools/window-sampler.ps1` 在交互桌面每 250ms 枚举可见顶层窗口，整轮启动期间应得到 `new windows=0` |
| **不许留在后台** | `-Supervise` 在同一进程树里守到收工：CDP 端口连续 `-ExitAfter` 秒没有 ESTABLISHED 连接（或到 `-MaxMinutes` 上限）就 `taskkill /T /F` + 删掉探针 home，然后自己 exit 0 | 停手后等一会儿：9333 不再 listen、探针进程 0、`%TEMP%\dsh-probe-imgprev` 不存在；脚本会打印 `supervisor: no CDP client for N s` |

为什么这两条要写成硬约定：探针是一个**完整的第二实例**（峰值约 450–600 MB、磁盘 30 MB），而且弹窗会直接打断正在用电脑的人。开发期一天要起十几次，靠“人记得关”必然漏。

### 一轮典型用法（自动收工）

```powershell
# 1. 起探针并守到收工（推荐；已有活的实例会复用，不会起第二个）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\probe.ps1 -Start -Supervise -ExitAfter 90 -MaxMinutes 20

# 2. 干活
node tools\cdp.mjs eval "document.baseURI"     # 在探针页面里求值
node tools\cdp.mjs shot C:\path\probe.png      # 截图（屏幕上什么都不会出现）

# 3. 90 秒没人连 CDP 它自己停；要立即停就 -Stop
powershell -NoProfile -ExecutionPolicy Bypass -File tools\probe.ps1 -Stop
```

**由 agent 起探针时，必须放进受管的后台任务**（DSH 的 `run_in_background`，或 `cmd /c start` 之外任何能让它活过这次调用的机制）。原因：DSH 会在**发起调用的那个工具调用结束时回收整棵进程树**——探针是那条树里的子进程，会跟着消失。表现是“刚起就 ECONNREFUSED”，不是 `-Stop` 生效了，也不是看门狗误杀。前台跑 `-Supervise` 时它本来就要占住终端，这时的行为是正确的。

### 参数

| 参数 | 作用 |
| --- | --- |
| `-Start` | 起探针（已有活的就复用）。单独用**不会**自停，留给“我就想留着一个慢慢看”的场合 |
| `-Supervise` | 配 `-Start`：守护到收工，然后自杀。`-ExitAfter`（默认 90 秒无 CDP 客户端）与 `-MaxMinutes`（默认 20 分钟兜底） |
| `-Stop` | 立刻杀整棵树 + 清 pid/端口/桌面记录 + **删掉探针 home**（默认；`-KeepHome` 保留） |
| `-Status` | pid / 端口 / CDP 目标 / 窗口挂在哪个桌面 |
| `-Visible` | 在当前桌面上起一个**看得见**的探针，仅人工排查用（这是唯一会弹窗的路径） |
| `-Arm` / `-Idle` | 在隐藏桌面上还原 / 收起窗口。`cdp.mjs shot` 会自动用它们——**最小化的窗口不产帧**，直接截会挂到超时（实测 30 秒、零字节），所以这步不能省 |
| `-KeepHome` | 停止时不删探针 home（默认删：里面有一份 `.credentials.yaml` 副本和会话副本，留着既占盘也不干净，下次 `-Start` 两秒重建） |

### 为什么没有“外挂看门狗”

一开始写的是“另起一个 powershell 盯着探针 pid”，两个坑在半小时内都踩了：**孤儿看门狗会清掉下一轮刚起的探针**（pid 文件被覆盖后它还活着），**它还会继承调用者的 stdout 管道**，把 `-Start` 挂住直到它自己退出（实测 180 秒超时）。所以生命周期一律交给“同一条树里的监守循环”，并加了代际校验：pid 文件一旦指向别的探针，旧的监守进程安静退出，绝不动别人的现场。

时间上的两个现实数字，别当 bug：启动固定要 ~30 秒（等窗口出现再最小化）；CDP 连接断开后 Chromium 侧还会挂约 30–45 秒才算非 Established，所以真实收工时间约等于“最后一次操作 + ExitAfter + 45 秒”。

### 隐藏桌面是怎么做出来的（踩过的坑，别绕开）

- 另外几条“让窗口不可见”的路都试过并否决了：最小化有 DWM 动画会闪；跨进程 `DwmSetWindowAttribute` 设隐身被系统拒绝（`0x80070005`）；把窗口挪到 `-32000,-32000` 会被 Electron 在显示时还原，实测仍有约 13ms 可见。
- **空闲不渲染**：窗口在该隐藏桌面上被最小化，稳定后 `renderer` / `gpu-process` 的 CPU 都是 0.00%——不会为一个没人看的“桌面显示”花资源。
- **但截图前必须 `-Arm`**：最小化的窗口**不产帧**，`Page.captureScreenshot` 不会给你一张黑图，而是挂起直到超时（实测 30 秒、一个字节都没有）。`-Arm` 还原后截出来是 2558×1640、5900 种颜色，连拍两张字节数一致；截完 `-Idle` 再收起，空闲 CPU 仍回到 0.00%。`cdp.mjs shot` 已内置这一对动作，且失败时会直说是“窗口最小化没有帧”。
- Windows 只合成你正在用的桌面，但 Chromium 自己照常出帧，所以截图不需要把窗口摆出来：实测 2558×1640、191 种颜色，与真实界面一致。
- 两个会话并发 `-Start` 有全局互斥锁兜底，不会起出两个实例。
- 探针的 `user-data` 是全新的，**不会**继承主实例的外观设置，所以它默认是浅色（纯白）。这是隔离的代价，不是 bug；真要一致，等主实例退出后把 `%APPDATA%\@deepseek-ai\dsh-desktop\Local Storage\leveldb` 拷进 `%TEMP%\dsh-probe-imgprev\user-data\Local Storage\leveldb`（leveldb 活着时被锁，拷不了）。
- 探针**没有**窗口投喂消息的入口：验正文装饰只能靠 CDP 往页面里注入一段含图片路径的 DOM，再等装饰器跑完读 `.dsh-ip-chip` / `.dsh-ip-figure`；验工具卡得让真会话里真跑过一次工具调用。想更省，客户端半优先用 `test/harness.html` 自测台，别为每次小改都起探针。

两个关键坑都已经写进脚本：DSH 的子进程环境带 `ELECTRON_RUN_AS_NODE=1`，不清掉它，`--remote-debugging-port` 会被 Node 当成非法参数；探针必须走独立 user-data，否则会和主实例抢单例锁。

`tools/cdp.mjs` 只用 Node 内置的 `fetch`/`WebSocket`（Node ≥ 22），不需要 Playwright。

> `tools/` 只在仓库里，`npm pack` 不带它（发布包不该带一个能再起一个应用实例的脚本）。`test/` 是带的，所以 `npm test` 装完能直接跑。


## 维护（给自己看的）

### 发一次版

1. 改 `package.json` 的 `version`（预 1.0 用 minor 表达行为变化）。
2. 在 `CHANGELOG.md` 顶部加一节：Added / Changed / Fixed / Security / Docs。
3. `npm run release:check` —— 一条命令查完：版本与 CHANGELOG 是否一致、语法、宿主测试、打包内容（该带的带、`tools/` 不带）、运行时依赖是否为零。
4. `git commit` → `git tag vX.Y.Z` → `git push --follow-tags`。
5. `npm publish`（本机手动发，见上一节）；或走仓库的 `publish` workflow（OIDC，见下）。

CI（`.github/workflows/ci.yml`）在 push / PR 上跑的就是 `npm run release:check`（Node 20 与 22 双矩阵），本地与 CI 用同一条命令，不会漂。

### 凭据怎么长期持有

原则：**长期凭据不落成明文文件**。这个仓库用到的只有两处。

| 用途 | 推荐做法 | 不要这样做 |
| --- | --- | --- |
| 推 GitHub | `gh auth login`（token 进 Windows 凭据管理器，之后 `gh auth setup-git` 让 git 复用它）；或 SSH key（无过期） | 把 PAT 存进 `~/.git-credentials` / `Documents\*.txt` |
| 发 npm（本机） | `npm login`（浏览器授权），token 落在 `%USERPROFILE%\.npmrc`；用 `icacls` 把该文件收紧到当前用户 | 把 token 写进仓库里的 `.npmrc` |
| 发 npm（长期/CI） | **trusted publishing（OIDC）**：`.github/workflows/publish.yml` 已备好，只声明 `id-token: write`、不存 token；在 npmjs 包的 Settings → Trusted publishing 里绑定 `repo + publish.yml` | 在仓库 Secrets 里放一个永不过期的 `NPM_TOKEN` |

盘点自己现在是什么状态（都不打印密钥）：

```powershell
gh auth status                 # GitHub 走的是 gh 凭据？
npm whoami                     # npm 登录的是谁
git config --get-all credential.helper   # 有没有 store 之类的明文 helper
```

`publish.yml` 是**手动触发**（Actions → publish → Run workflow，默认 `dry_run: true` 只演练）。首次发布时 npm 上还没有这个包、OIDC 无处绑定，所以第一次在本机 `npm login` + `npm publish`；发出去之后去包设置里绑定，从此不再需要 token。

### 宿主版本一变，先查这几处

| 会变的东西 | 影响面 | 症状 / 自检 |
| --- | --- | --- |
| `tool.call.toolview` 的 props | 工具卡 | 退回通用工具行；`mounts` 里没有 `card-render` |
| `output.presentationMeta` | 卡片取图来源 | 卡片按参数画图（`dir` 调用会空），工具结果本身正常 |
| `ctx.webServer.register` / `connection.requestRejection` | 全部取图 | 图全“打不开”；无凭证访问 `/image-preview/file` 不再是 401 |
| 会话 DOM 的文本节点 / `data-chat-*-key` | 正文装饰、←/→ 翻页范围 | 路径仍是纯文字；翻页退化成整页范围 |
| client bundle 装配（`__ModuleLoader__`） | 整个 browser 半 | `mounts` 里三步全缺 |

### 什么时候必须验客户端半

改动落在 `client.js` 就必须验；纯 host 改动跑 `npm test` 就够。客户端半**唯一**的自动化入口是 `test/probe-assertions.js`（走探针），别拿肉眼当回归测试。

### 兼容性承诺

- 只承诺 **Windows 盘符路径**（`C:\…` / `C:/…`）；POSIX 路径不在范围内。
- 宿主版本没有下限声明（`engines` 只管 Node ≥ 20）；契约变化按上表查，不靠猜。
- 发布包**不带** `tools/`（它会再起一个应用实例），带 `test/`，所以装完能 `npm test`。

## 发布与分享

本目录已经是一个可直接发布的包：MIT、`files` 白名单 5 个手写条目（含 `test/`，所以装完也能 `npm test`）、`npm pack` ≈ 53 kB（解包 161 kB，11 个文件）、`npm test` 可移植（自带临时素材，不依赖本机路径）。

**发到 npm**

```sh
cd <本目录>
npm login          # 浏览器登录 npmjs.com；没有账号先去 https://www.npmjs.com/signup
npm publish        # 发布（账号开了 2FA 会要一次 OTP，或改用 Automation Token）
```

不想交互登录，就用 token：

1. npmjs.com → 头像 → Access Tokens → Generate New Token → **Granular Access Token**，权限 Read and write，勾选 bypass 2FA；
2. `npm publish --//registry.npmjs.org/:_authToken=npm_你的token`。

**发到 GitHub**

```sh
gh auth login                                             # 一次性
gh repo create dsh-plugin-image-preview --public --source=. --push
```

**离线分享**：`npm pack` 产出的 tgz（例如 `dsh-plugin-image-preview-0.3.0.tgz`）直接发给别人，对方在 profile 里 `file:` 指向该 tgz 即可。tgz 不入库（`*.tgz` 已 gitignore），用的时候现打——仓库里躺着的那份迟早和源码对不上。

**装到别的机器**：web profile 用 `dsh plugin add dsh-plugin-image-preview`；desktop profile 走插件管理器，或按上文「本地目录开发」的 `file:` + junction 方式手接（desktop 这个名字被保留，`dsh plugin --profile desktop` 会被拒）。

## 升级 DSH 之后怎么自检（三个面各自独立）

本插件刻意把三个面分开挂载、各自 try/catch，任意一个随宿主升级失效都不会拖垮其它：

| 面 | 依赖 | 失效表现 | 自检 |
| --- | --- | --- | --- |
| 取图路由 | `ctx.webServer.register` + `connection.requestRejection` | 缩略图/卡全变“打不开”，退回官方 `api/file` 也失败 | `GET /image-preview/diag` 返回 200 JSON 即活着（不带会话凭证时只报 `trusted:false` + 各面挂载情况，不报任何文件） |
| 工具卡 | `tool.call.toolview` 的 props 形状 | 卡片只剩通用行/文字 | `mounts` 里出现 `card-render n=… k=…` |
| 正文装饰 | 会话 DOM 的文本节点 | 路径仍是普通文字 | `mounts` 里出现 `text-watch`，且点击路径有取图请求 |

客户端 mount 会把 `style` / `slots-registered` / `text-watch` 三步上报到 `/image-preview/client-report`，宿主按 **stage 各留一条**（不是挤在同一个滚动环里），所以一屏十几张图把它们挤出 `recent` 也不影响这一步自检。升级后只要 `mounts` 里能看到这三步 + `card-render`，就说明装配没被改坏；哪一步缺席就改哪一层，不用猜。

`/diag` 的读写都过 `connection.requestRejection`：带会话凭证（页面里 fetch）时返回完整报告，含 `recent` 与任意路径探测结果；**不**带凭证时只回存活与 `mounts`，不泄露任何路径。`/client-report` 是写请求，未授权直接 401。

## 改完代码怎么生效

- `index.js`（host 半）：**必须重启应用**。
- `client.js`（browser 半）：`dsh-client-hmr` 只在 `pnpm run dev:web` 的重建通知下热替换；桌面版的窗口通常吞掉 `Ctrl+R`/`Ctrl+Shift+R`，所以实际做法是**重启应用**，或在「设置 → 插件」里把本插件关掉再打开（会触发该条目重载）。

## 依赖与占用

给维护者的一页账：这东西依赖什么、缺了会怎样、占多少、怎么自己量。

### 运行时依赖：零

| 半边 | 依赖 | 说明 |
| --- | --- | --- |
| Host | `node:fs` / `node:fs/promises` / `node:path` | 只用 Node 内置模块。`package.json` 没有 `dependencies` 字段，`npm ls --omit=dev` 输出 `(empty)` |
| Browser | 宿主那份 `react` | 通过 `require('react')` 借用宿主已有的 React，不自带、不打包；除此之外没有别的 import |
| 开发/测试 | 无 | `test/` 只用 Node 内置，纯断言 + 退出码，没有测试框架 |

体积：`client.js` 82 KB（gzip 23 KB）、`index.js` 33 KB（gzip 11 KB）、`npm pack` 53 KB / 解包 161 KB / 11 个文件。

### 宿主能力依赖（缺了会怎样、怎么自检）

| 能力 | 用途 | 缺了的表现 | 自检 |
| --- | --- | --- | --- |
| `ctx.tools.register` | `preview_image` | 工具不存在 | `Tool.listTools` 里能看到 `preview_image` |
| `ctx.systemPrompt.section` | 一段用法提示 | 模型不知道要写正文路径 | 提示词里有 `plugin:image-preview` |
| `ctx.webServer.register({ kind: 'prefix' })` | 五条路由 | 图全变“打不开”，退回官方 `api/file` 也失败 | `GET /image-preview/diag` 返回 200 |
| `connection.requestRejection` | Host/Origin + 会话凭证闸门 | 所有路由 503（**失败关闭**，宁可不可用也不裸奔） | 无凭证访问 `/image-preview/file` 得 401 |
| `output.presentationMeta` | 让卡片知道“这次真的产出了什么” | 卡片退回按参数画图，`dir` 模式会空 | 卡片能显示 `dir` 调用的图 |
| `slots.inject` + `slots.register('tool.call.toolview')` | 工具卡 | 卡片退回通用工具行 | `mounts` 里有 `card-render` |
| 会话 DOM 的文本节点 | 正文装饰 | 路径仍是普通文字 | `mounts` 里有 `text-watch` |

### 磁盘

- 插件本身**不写盘**：没有缓存文件、没有日志、没有状态目录。
- 唯一足迹是**探针**：`%TEMP%\dsh-probe-imgprev`，实测约 30 MB（`user-data` 22.7 + 会话副本 4.7 + 截图 2.6）。`-Stop` 或自停时整目录删除——里面有一份 `.credentials.yaml` 副本，所以“默认删”是硬要求，不是洁癖。
- 仓库不留二进制产物：`*.tgz`、`*.log`、`node_modules/` 都在 `.gitignore`；行尾由 `.gitattributes` 固定为 LF，避免 Windows 上 `core.autocrlf=true` 造成的无意义 diff。

### 内存

| 位置 | 上限 | 说明 |
| --- | --- | --- |
| Host 读图 | 每请求一条流 | `createReadStream` 直出，不把整张图读进堆；单文件上限 64 MB（`MAX_BYTES`） |
| Client 字节缓存 | 32 项，单图 >16 MB 不驻留 | 每项是一个 `Blob`（≈ 图片体积）；淘汰时 `revokeObjectURL`，仍被 `<img>` 引用的跳过 |
| Client 并发 | 3 路 | 一屏 24 张不会同时打满 |
| Client 每张图 | 一份 `Blob` | 不再有 base64 字符串、不再有 `data:` URL |

### CPU 与网络

- 装饰器：`MutationObserver` 驱动（`childList` + `characterData`），外加 **250 ms** 定时器兜底——隐藏/最小化窗口里 rAF 会停摆，靠定时器继续推进；**没有任何轮询**。
- 兜底扫描：15 s 一次，`visibilityState === 'hidden'` 时直接跳过；回到前台补扫一次。
- 取图：同一 `(路径, 刷新序号)` 只发一次 `POST`；一屏多处引用同一张只取一次。
- 失败路径：`HTTP 404` 视为定案（文件级结论），不再走 URL 兜底；否则最多 12 个候选。

### 端口与路由（都挂在宿主的 webServer 上）

| 路由 | 方法 | 暴露面 | 鉴权 |
| --- | --- | --- | --- |
| `/image-preview/read` | POST | 图片字节（路径在 JSON 体里） | 要 |
| `/image-preview/file?path=` | GET | 图片字节 | 要 |
| `/image-preview/blob/<base64url>` | GET | 图片字节 | 要 |
| `/image-preview/diag` | GET | 存活 + 各面挂载；**带凭证**才回路径细节与 `recent` | 无凭证只回存活 |
| `/image-preview/client-report` | POST | 客户端挂载上报 | 要 |

不开新端口，全部复用宿主已有端口。

### 对模型上下文的占用

- 系统提示：约 400 字，每会话一份。
- 工具结果：每张图一行「路径 · 类型 · 体积」，最多 24 行；跳过原因最多 6 行。
- 图片本身**不进**上下文。

### 卸载时清掉什么

`style` 标签、悬停浮层、全屏查看器、字节缓存里的 object URL、路由注册、系统提示段——全部挂在 `ctx.effect` 的 disposer 上，插件卸载/热重载时自动执行。

### 自己量一遍

```powershell
npm ls --omit=dev                  # 运行时依赖：应为 (empty)
npm pack --dry-run                 # 包体积 / 文件数
node --check index.js; node --check client.js
npm test                           # 24 条宿主断言（退出码即结论）
node -e "const z=require('zlib'),fs=require('fs');console.log('gzip', z.gzipSync(fs.readFileSync('client.js')).length)"
powershell -NoProfile -ExecutionPolicy Bypass -File tools\probe.ps1 -Status   # 探针在不在、挂哪个隐藏桌面
```

## 已知边界

- 只认**盘符绝对路径**。正文装饰不处理相对路径（DOM 里没有会话 cwd）；`preview_image` 则按会话 cwd 解析相对路径，但取图路由没有会话上下文，所以路由一律拒绝相对路径并明确说“只接受绝对路径”，不会让你看到一张莫名其妙的 404 图。
- 看的是磁盘上的当前文件：同一路径被覆盖写后，已渲染的图不会自动变，点查看器的「刷新」才重取。
- 正文改写依赖会话 DOM 的文本节点；宿主把某段正文改成 canvas/自定义组件渲染时，那段里的路径就不会被识别（不影响其它位置）。
- **只隐藏“整块只有路径”的原文**：路径独占一行、或一行里只有若干路径时会隐藏；夹在句中的路径保留文字，因为隐藏子串必须切开 React 的文本节点，流式写回会出重复文本（风险大于收益）。
- 文案是中文硬编码，没有接 `ctx.locale`。
