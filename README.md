# dsh-plugin-image-preview

> **English** — Preview local images inside a [DeepSeek Harness](https://github.com/deepseek-ai) conversation, without leaving the chat: absolute image paths in prose grow a thumbnail (a path alone on its line becomes a full inline preview), a `preview_image` tool card shows a gallery, and a full-screen viewer zooms, pans, pages between images and copies the current one to the clipboard as PNG. Images never enter the model context, so a preview costs no tokens.
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
3. **`preview_image` 工具卡。** 模型生成图之后调一次 `preview_image`，会话里就会出现一张缩略图网格卡（不是一行路径），点缩略图看大图。图片只给用户看，**不进模型上下文，不烧 token**。
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
POST /image-preview/read   请求体 {"path":"C:\\…"}
→ {"ok":true,"mediaType":"image/png","bytes":…,"base64":"…"}
```

路径只在 JSON 请求体里，不过任何 URL 编码。客户端按 `POST → 路径段 → 查询串 → 官方 api/file` 的顺序兜底，前一层成功就不走后面。

识别规则（刻意保守，避免把普通文字变成按钮）：

| 写法 | 结果 |
| --- | --- |
| `C:\dir\fig.png` · `C:/dir/fig.png` | ✅ 变成图片按钮 |
| `C:\dir\a (1).png`（含空格） | ✅ 变成图片按钮 |
| `![](C:\dir\fig.png)` | 官方直接内嵌缩略图 + 官方灯箱（插件不重复处理） |
| 反引号 `` `C:\dir\fig.png` ``、链接 `[x](…)` | 官方已经是文件按钮，插件不改写 |
| `file:///C:/x.png`、`\\server\share\x.png`、`x.png?raw=1` | ❌ 不识别（官方 `api/file` 也拒绝） |
| `https://example.com/a.png` | ❌ 不识别（不是本地路径） |
| `10:30`、`a:b` | ❌ 不是盘符路径 |
| `code` / `pre` / `a` / `button` / 输入框 / 侧栏 | ❌ 不改写 |

**写路径请优先用正斜杠**（`C:/Users/me/fig1.png`）。Markdown 会把反斜杠当转义符：`\_`、`\(`、`\)` 会把那个反斜杠吃掉——本机实测 `Documents\_dsh_tmp\x.png` 渲染成 `Documents_dsh_tmp\x.png`，插件按渲染后的文本取图，自然 `404 文件不存在`。用正斜杠、或者把路径放进行内代码里，就绕开了。

支持 png / jpg / jpeg / webp / gif / bmp / avif，宿主半按文件头嗅探，扩展名与内容不符会拒绝并说明原因。

## 两半的分工

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | `preview_image` 工具（存在性、魔数、大小校验；`dir` 取最新）；一段系统提示公告；只读取图路由 `GET /image-preview/file?path=<绝对路径>`（过 Host/Origin 与会话 cookie 闸门，只回六种位图，按魔数判定，`no-store`） |
| Client | `client.js` | `tool.call.toolview` 的 `preview_image` 卡；正文路径的缩略图与整块预览（MutationObserver，只追加、不切文本，自己插入的元素带 `data-ip-own`）；悬停预览；全屏查看器（缩放/平移/翻页/复制/刷新） |

**取图有三层兜底**：先试本插件自己的路由，再试宿主官方的 `api/file`，每条都用 `document.baseURI`／页面 URL／origin／`dsh-app://app/` 四种基址和路径的两种斜杠写法；`<img>` 直接取失败时改用 `fetch` 取字节转 blob 再显示。三层都失败才报错，并把 HTTP 状态、实际 URL、`baseURI` 写在屏幕上。

不开 Cordis 服务、不读别的插件的 DOM 结构（只对文本节点做原地追加，且只动自己插入的元素）。

## 自测

`test/harness.html` 是一个空壳页面，用一个假 React 和假 ctx 加载 `client.js`，覆盖：路径识别（含空格、中文标点、URL 反例）、跳过区域（code/pre/a/button/contenteditable/aside）、流式重渲染不重复、点开/翻页/Esc。

```powershell
cd <本插件目录>
node test\serve.cjs          # http://127.0.0.1:8765/test/harness.html
node --check index.js; node --check client.js
```

`serve.cjs` 顺带模拟了宿主的 `/api/file?path=`，所以自测台里图片是真能加载出来的；它**不**实现插件自己的 `/image-preview/file`，正好顺带验证「插件路由 404 → 官方路由命中」这条兜底链。

## 显示位置与折叠（重要）

- **正文里的路径永远可见**：会话的「Work details」折叠只作用于**已完成回合的过程行**（工具卡、命令、推理预览），不作用于答案正文。所以把路径写进正文、让它直接渲染成缩略图/整块预览，是唯一“不会被折叠”的用法——本插件的默认建议就是这个。
- `preview_image` 的工具卡在 `compact`/`standard`/`detailed` 模式下会被折进「已完成，用时 N 秒」，需要展开才看到；`verbose` 模式不折叠（但会让**所有**过程行常显，噪音大）。官方没有“只豁免图片卡”的开关。
- 想要“回合末尾常显的图片带”，只能再注册 `conversation.chat.turnTail`（折叠之外），它只给 `{ turn, seq, openFile }`，要靠 `ChatNodeStore.turnDataSource` 反查该回合的图片——更贴近内部契约，暂未实现。

## 探针实例（这次开发里搭的自测手段）

改客户端插件最烦的是“只有真实窗口能验”。`tools/probe.ps1` 起一个**独立**的 Harness 实例：独立 `user-data-dir`、独立 `DSH_HOME`（配置与会话从真实 profile 拷一份）、`node_modules` 用 junction 共享，并打开 CDP 端口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe.ps1 -Start    # 起探针
node tools/cdp.mjs eval "document.baseURI"                                    # 在探针页面里求值
node tools/cdp.mjs shot C:\path\probe.png                                     # 探针窗口截图
powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe.ps1 -Stop     # 关掉
```

两个关键坑都已经写进脚本：DSH 的子进程环境带 `ELECTRON_RUN_AS_NODE=1`，不清掉它，`--remote-debugging-port` 会被 Node 当成非法参数；探针必须走 `-WindowStyle` + 独立 user-data，否则会和主实例抢单例锁。

`tools/cdp.mjs` 只用 Node 内置的 `fetch`/`WebSocket`（Node ≥ 22），不需要 Playwright。

## 发布

```sh
npm login          # 一次性
npm publish        # 发布本目录（files 白名单已限定 6 个文件）
```

本机当前 npm 未登录（`npm error code ENEEDAUTH`），所以这一步留给你；登录后 `npm publish` 即可。`npm pack --dry-run` 的打包结果是 6 个文件、31.5 kB。

## 升级 DSH 之后怎么自检（三个面各自独立）

本插件刻意把三个面分开挂载、各自 try/catch，任意一个随宿主升级失效都不会拖垮其它：

| 面 | 依赖 | 失效表现 | 自检 |
| --- | --- | --- | --- |
| 取图路由 | `ctx.webServer.register` + `connection.requestRejection` | 缩略图/卡全变“打不开”，退回官方 `api/file` 也失败 | `GET /image-preview/diag?path=…` 返回 200 JSON 即活着 |
| 工具卡 | `tool.call.toolview` 的 props 形状 | 卡片只剩通用行/文字 | `diag` 的 `recent` 里出现 `stage=card-render n=… k=…` |
| 正文装饰 | 会话 DOM 的文本节点 | 路径仍是普通文字 | `recent` 里出现 `stage=text-watch`，且点击路径有取图请求 |

客户端 mount 会把 `style` / `slots-registered` / `text-watch` 三步上报到 `/image-preview/client-report`，宿主记进同一个 `recent` 环。升级后只要 `diag` 能看到这三步 + `card-render`，就说明装配没被改坏；哪一步缺席就改哪一层，不用猜。

## 改完代码怎么生效

- `index.js`（host 半）：**必须重启应用**。
- `client.js`（browser 半）：`dsh-client-hmr` 只在 `pnpm run dev:web` 的重建通知下热替换；桌面版的窗口通常吞掉 `Ctrl+R`/`Ctrl+Shift+R`，所以实际做法是**重启应用**，或在「设置 → 插件」里把本插件关掉再打开（会触发该条目重载）。

## 已知边界

- 只认**盘符绝对路径**。相对路径在 DOM 里无法解析（缺会话 cwd），故意不做。
- 看的是磁盘上的当前文件：同一路径被覆盖写后，已渲染的图不会自动变，点查看器的「刷新」才重取。
- 正文改写依赖会话 DOM 的文本节点；宿主把某段正文改成 canvas/自定义组件渲染时，那段里的路径就不会被识别（不影响其它位置）。
- 文案是中文硬编码，没有接 `ctx.locale`。
