# CO-AGENT

[中文](#中文) · [English](#english)

---

## 中文

CO-AGENT 是一个运行在本机的 Windows 桌面软件，用来浏览、统计和调用你自己写的 Claude Code / Codex CLI 自定义 Agent，包括「工具 Agent」和绑定一本书的「书籍 Agent」。界面是中文的。

### 能做什么

- **目录**：自动扫描 `~/.codex/agents/*.toml` 和 Claude 的 `agents/*.md`，按「工具 Agent」和书籍分类列出，显示调用次数和最近使用情况。
- **启动**：在 Windows Terminal 里用 Codex CLI 或 Claude CLI 打开某个 Agent 的会话；可以联合调用多个 Agent，也可以按分组提问。
- **对话**：在软件里直接和一个或多个书籍 Agent 对话（只读运行）。
- **讨论**：
  - 圆桌讨论：几本书一起回答一个问题；
  - 会诊室：从多个视角分析一个处境；
  - 顾问团：一组固定的书反复开会。
- **每日概念**：每天由一个书籍 Agent 讲一个读者「不知道自己不知道」的概念，也可以手动生成。
- **读书**：在软件里阅读书籍 Agent 绑定的原书（PDF / EPUB），记住阅读位置，记录研读时长。
- **制作书籍 Agent**：在 设置 → Agent 管理 里选一本书（PDF、EPUB、MOBI 或 AZW3），CO-AGENT 会在终端里打开一个 a-deepbooker 会话。它把这本书做成书籍 Agent，同时生成完整报告。整个过程在终端里进行，需要你确认它的操作。a-deepbooker 和它需要的文件在本仓库的 `bookmaker/` 文件夹里，安装方法见 [bookmaker/README.md](bookmaker/README.md)。
- **其他**：四种排版（三栏、便当格、杂志、书房），一键备份。

### 需要什么

- Windows 10 / 11（x64）
- PowerShell 7（`pwsh`）和 Windows Terminal（`wt`），用于安装和打开 Agent 会话
- [Codex CLI](https://github.com/openai/codex)（默认引擎）和/或 [Claude Code](https://docs.anthropic.com/claude-code)，已安装并登录
- 从源码构建时还需要 [Node.js](https://nodejs.org/) 24
- git（可选：只有在备份时打包代码才需要）

### 安装方式一：下载打包好的程序

1. 在本仓库的 Releases 页面下载 `CO-AGENT-<版本>-win32-x64.zip` 和同名的 `.sha256` 文件。
2. 在 PowerShell 里核对文件，并解除下载标记（否则 Windows 会拦下解压出来的脚本和程序）：

   ```powershell
   (Get-FileHash .\CO-AGENT-<版本>-win32-x64.zip).Hash   # 应与 .sha256 文件里的值相同（不区分大小写）
   Unblock-File .\CO-AGENT-<版本>-win32-x64.zip
   ```

3. 解压，在解压出来的文件夹里运行：

   ```powershell
   pwsh -File scripts\install.ps1      # 安装到 %LOCALAPPDATA%\Programs\CO-AGENT，并建开始菜单和桌面快捷方式
   ```

程序没有代码签名。如果 Windows 显示「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。

### 安装方式二：从源码构建

```powershell
npm ci                               # 安装 electron 和 @electron/packager
npx install-electron                 # 下载 Electron 程序本身（Electron 44 起 npm ci 不再自动下载）
npm test                             # 全部测试，不会调用真实的 claude 或 codex
npm run package                      # 用下载好的 Electron 离线打包，输出到 release\CO-AGENT-win32-x64
pwsh -File scripts/install.ps1       # 安装到 %LOCALAPPDATA%\Programs\CO-AGENT，并建开始菜单和桌面快捷方式
```

只有 `npm ci` 和 `npx install-electron` 需要联网。`npm run release` 会把打包好的程序做成方式一用的 ZIP（输出到 `release\`）。

### 安装之后

- **每日概念计划任务**：加上 `-DailyConcept`，会注册每天 09:00 自动生成概念的计划任务。这个任务会调用 Codex，所以默认不注册。
- **卸载**：`pwsh -File scripts/install.ps1 -Uninstall`。卸载会保留你的数据。

### 第一次使用

1. **基本配置**：第一次打开时，设置窗口会自动打开到「基本配置」。在这里确认称呼、Codex 模型（留空就用 Codex 自己的默认设置）、终端显示在哪个屏幕，以及几个文件夹。保存后重启软件生效。
2. **Agent 管理**：在 设置 → Agent 管理 里：
   - 先添加书的分类；
   - 再把电脑上已有的 Agent 登记为工具 Agent（写一句用途）或书籍 Agent（填书名、作者、版本、分类）。
   - 如果开启了「允许导入 Agent 文件」，也可以在这里导入 `.toml`（Codex 版）或 `.md`（Claude 版）文件。导入只会新建文件，不会覆盖已有的文件。
   - Agent 文件就是 Codex 或 Claude 会照着执行的指令，所以只导入你信任的文件。不需要导入时，可以在基本配置里关掉这个开关。

目录以 Codex 版 Agent 为准；同名的 Claude 版会配成一对。

### Agent 目录清单

软件从「Agent 目录清单文件夹」读取下面五个文件。这个文件夹默认是数据目录下的 `catalog`，可以在基本配置里改。缺少的文件按空清单处理。

| 文件 | 内容 |
|---|---|
| `roles.json` | 工具 Agent 的名字、中文用途、审查角色 |
| `book-categories.json` | 书的分类，以及每个书籍 Agent 的书名、作者、版本、分类 |
| `book-blurbs.json` | 抽出一本书时显示的两句话简介 |
| `book-reports.json` | Word 报告所在的文件夹，以及每本书对应哪份报告 |
| `task-contracts.json` | 哪些 Agent 的提问要用固定的任务格式 |

示例见 `test/fixtures/catalog/`。在软件里登记的条目保存在数据目录的 `catalog-additions.json` 和 `book-additions.json`，软件不会改动清单文件夹里的文件。

### 数据和隐私

- **数据位置**：所有记录都在 `%LOCALAPPDATA%\CO-AGENT`（也可以用环境变量 `CO_AGENT_DATA_DIR` 指定别的位置）。设置 → 立即备份 会把这些记录打成一个 ZIP。
- **本地服务**：软件的本地服务只监听 `127.0.0.1`；每次启动都会生成新的 token，所有写操作都要带上它。
- **不联网**：软件本身不联网，没有统计或遥测。它只会调用你自己安装的 `claude` 和 `codex`。
- **对话只读**：在软件里对话时，Claude 只能用读取类工具，Codex 在只读沙盒里运行。

### 开发

- 运行时代码只用 Node.js 标准库，前端是原生 HTML/CSS/ES 模块，桌面外壳是 Electron。
- `npm start` 只启动本地服务：`http://127.0.0.1:47821`。
- `npm test` 运行全部测试。
- 开发规则见 `AGENTS.md`。

### 许可证

MIT © 2026 deepcoder888，见 `LICENSE`。

---

## English

CO-AGENT is a local Windows desktop app for browsing, counting and launching your own Claude Code / Codex CLI custom agents. It handles both "tool agents" and "book agents" (an agent bound to one book). The interface is in Chinese.

### What it does

- **Directory**: scans `~/.codex/agents/*.toml` and Claude's `agents/*.md`, lists the agents as tool agents and book categories, and shows how often and how recently each was used.
- **Launching**: opens a Codex CLI or Claude CLI session for an agent in Windows Terminal. You can also run joint calls across several agents and ask saved groups.
- **Chats**: talk with one or more book agents inside the app; these runs are read-only.
- **Rooms**:
  - roundtables, where several books answer one question;
  - consultations, which look at one situation from several angles;
  - councils, a fixed set of books that meets repeatedly.
- **Daily concept**: each day one book agent explains a concept readers "don't know they don't know". You can also generate one by hand.
- **Reading**: read a book agent's original book (PDF / EPUB) in the app, with saved positions and reading time.
- **Making book agents**: in Settings → Agent 管理, choose a book (PDF, EPUB, MOBI or AZW3) and CO-AGENT opens an a-deepbooker session in Windows Terminal. a-deepbooker turns the book into a book agent and writes its full reports. The work runs in the terminal, where you approve what it does. a-deepbooker and the files it needs are in this repository's `bookmaker/` folder; see [bookmaker/README.md](bookmaker/README.md) to install them.
- **Other**: four layouts and one-click backup.

### Requirements

- Windows 10 / 11 (x64)
- PowerShell 7 (`pwsh`) and Windows Terminal (`wt`), to install and to open agent sessions
- [Codex CLI](https://github.com/openai/codex) (the default engine) and/or [Claude Code](https://docs.anthropic.com/claude-code), installed and signed in
- [Node.js](https://nodejs.org/) 24, only to build from source
- git (optional; only needed when a backup includes code)

### Install option 1: download the built app

1. From this repository's Releases page, download `CO-AGENT-<version>-win32-x64.zip` and the `.sha256` file of the same name.
2. In PowerShell, check the file and remove the download mark (otherwise Windows blocks the scripts and the program inside):

   ```powershell
   (Get-FileHash .\CO-AGENT-<version>-win32-x64.zip).Hash   # must equal the value in the .sha256 file (case does not matter)
   Unblock-File .\CO-AGENT-<version>-win32-x64.zip
   ```

3. Extract it, and in the extracted folder run:

   ```powershell
   pwsh -File scripts\install.ps1      # installs to %LOCALAPPDATA%\Programs\CO-AGENT with Start Menu and desktop shortcuts
   ```

The program is not code-signed. If Windows shows "Windows protected your PC", click "More info" → "Run anyway".

### Install option 2: build from source

```powershell
npm ci                               # installs electron and @electron/packager
npx install-electron                 # downloads the Electron program itself (since Electron 44, npm ci no longer does)
npm test                             # the full suite; it never calls the real claude or codex
npm run package                      # builds release\CO-AGENT-win32-x64 offline from the downloaded Electron
pwsh -File scripts/install.ps1       # installs to %LOCALAPPDATA%\Programs\CO-AGENT with Start Menu and desktop shortcuts
```

Only `npm ci` and `npx install-electron` need a network. `npm run release` turns the built app into the ZIP for option 1 (in `release\`).

### After installing

- **Daily-concept task**: `-DailyConcept` registers a scheduled task that generates the day's concept at 09:00. It calls Codex, so it is not registered by default.
- **Uninstall**: `pwsh -File scripts/install.ps1 -Uninstall`. Your data is kept.

### First start

1. **基本配置 (Basic settings)**: on the first start the settings window opens at this section. Confirm your name, the Codex model (empty means Codex's own default), which display terminals open on, and a few folders. Changes apply after a restart.
2. **Agent 管理 (Agent manager)**: in Settings → Agent 管理:
   - add book categories first;
   - then list agents already on your computer as tool agents (with a one-line purpose) or as book agents (title, author, edition, category).
   - With "allow importing agent files" on, you can also import a `.toml` (Codex) or `.md` (Claude) file here. Imports only create new files and never overwrite one.
   - An agent file is a set of instructions Codex or Claude will follow, so only import files you trust. You can turn the switch off in 基本配置 when you don't need it.

The directory is built from Codex agents; a Claude agent with the same name is paired with it.

### Agent lists

The app reads five files from the agent list folder. By default this is `catalog` in the data folder; you can change it in 基本配置. A missing file counts as an empty list.

| File | Contents |
|---|---|
| `roles.json` | tool agent names, purposes and reviewer roles |
| `book-categories.json` | book categories, and each book agent's title, author, edition and category |
| `book-blurbs.json` | the two-sentence card shown for a book |
| `book-reports.json` | the Word report folder and which report belongs to which book |
| `task-contracts.json` | agents whose questions use a fixed task format |

See `test/fixtures/catalog/` for an example. Entries added in the app are saved in `catalog-additions.json` and `book-additions.json` in the data folder; the app never changes the files in the list folder.

### Data and privacy

- **Data location**: all records live in `%LOCALAPPDATA%\CO-AGENT`. You can choose another folder with the `CO_AGENT_DATA_DIR` environment variable. Settings → 立即备份 packs them into one ZIP.
- **Local server**: it listens only on `127.0.0.1`. Every start creates a new token, and every write request must carry it.
- **No network**: the app itself makes no network calls and has no telemetry. It only runs the `claude` and `codex` CLIs you installed.
- **Read-only chats**: in-app chats give Claude read-only tools and run Codex in its read-only sandbox.

### Development

- Runtime code uses only the Node.js standard library; the front end is plain HTML/CSS/ES modules; the desktop shell is Electron.
- `npm start` runs only the local server, at `http://127.0.0.1:47821`.
- `npm test` runs the suite.
- Development rules are in `AGENTS.md`.

### License

MIT © 2026 deepcoder888. See `LICENSE`.
