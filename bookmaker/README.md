# a-deepbooker：把一本书做成书籍 Agent / Turn a book into a book Agent

[中文](#中文) · [English](#english)

---

## 中文

a-deepbooker 通读一本书一遍，同时完成两件事：

- **做成书籍 Agent**：这个 Agent 只读、绑定这本书的版本，回答时会回到原文核对；
- **生成完整报告**：两份 Deepbooker README 报告，以及一份合并后的 Word 文件。

CO-AGENT 的 设置 → Agent 管理 → 制作书籍 Agent 会在终端里打开它。

### 包含什么

| 文件夹 | 内容 |
|---|---|
| `codex/agents/` | `a-deepbooker.toml`、`a-book.toml`（Codex 版） |
| `claude/agents/` | `a-deepbooker.md`、`a-book.md`（Claude 版） |
| `agent-support/a-deepbooker/` | 流程说明、运行时（`runtime.py`、`workflow.py`）、依赖锁 `dependencies.json` |
| `agent-support/a-book/` | A-book 的流程说明、运行时和测试 |
| `plugins/deepbooker/` | Deepbooker 技能：读书、两份报告、Word |
| `tools/validate-reading-state.ps1` | 阅读状态校验 |

### 需要什么

- **基础环境**：Windows、PowerShell 7、Python 3.11 或更高版本。
- **Agent 运行环境**：Codex CLI；或者 Claude Code，配合同名的 Codex 版使用。
- **PDF 环境**：处理 PDF 需要装了 `pypdf` 的 Python，放在 `<DEEPBOOKER_HOME>\.deepbooker-work\documents-runtime\`。
- **其他人的工具**（本仓库不附带，请按各自说明安装）：
  - [nlpm](https://github.com/xiaolai/nlpm)：生成 Agent 前的质量审查；
  - XROS 方法插件：报告研究阶段使用；
  - Office CLI：生成 Word。

### 安装（把文件复制到这些位置）

| 从 | 复制到 |
|---|---|
| `codex/agents/*.toml` | `%USERPROFILE%\.codex\agents\` |
| `claude/agents/*.md` | `%USERPROFILE%\.claude\agents\`（可选，用 Claude 时需要） |
| `agent-support/a-deepbooker`、`agent-support/a-book` | `%USERPROFILE%\.codex\agent-support\` |
| `plugins/deepbooker` | `<DEEPBOOKER_HOME>\plugins\deepbooker` |
| `tools/validate-reading-state.ps1` | `<DEEPBOOKER_HOME>\.deepbooker-work\` |

**要原样复制**：`dependencies.json` 锁定了这些文件的 SHA-256。改过任何一个文件，运行时都会报告 `dependency drift requires review`，然后停止。

### 设置

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `DEEPBOOKER_HOME` | Deepbooker 的工作文件夹（技能、报告、Word、工作文件） | `%USERPROFILE%\Documents\Deepbooker` |
| `DEEPBOOKER_READY_DIR` | 做好的 Word 副本放在这里 | `%USERPROFILE%\Documents\READY TO READ` |

- **模型**：a-deepbooker 和 a-book 不指定模型，使用你 Codex 的默认模型。
- **生成的书籍 Agent**：默认使用 `gpt-5.6-sol`、推理强度 `xhigh`，可以在请求里改。

### 检查是否装好

在 `%USERPROFILE%\.codex\agent-support` 里运行：

```powershell
'{"op":"dependencies"}' | Set-Content req.json
python -X utf8 -B a-deepbooker\runtime.py --request req.json
```

返回 `"status": "READY"` 就是装好了。

### 注意

- **时间**：一本书通常要几个小时。
- **在终端里确认**：它会新建 Agent 文件、知识包、报告和 Word，过程中需要你在终端里确认。
- **原书**：只处理你自己合法拥有的原书。不上传私人书籍，不绕过 DRM，不代为购买。

---

## English

a-deepbooker reads a book once and produces two things:

- **A book Agent**: read-only and bound to that edition; it rechecks the source before answering.
- **The complete reports**: two Deepbooker README reports and one merged Word file.

CO-AGENT opens it in a terminal from Settings → Agent 管理 → 制作书籍 Agent.

### What is included

| Folder | Contents |
|---|---|
| `codex/agents/` | `a-deepbooker.toml`, `a-book.toml` (Codex) |
| `claude/agents/` | `a-deepbooker.md`, `a-book.md` (Claude) |
| `agent-support/a-deepbooker/` | workflow docs, runtimes (`runtime.py`, `workflow.py`), dependency lock `dependencies.json` |
| `agent-support/a-book/` | A-book workflow docs, runtimes and tests |
| `plugins/deepbooker/` | the Deepbooker skill: reading, two reports, Word |
| `tools/validate-reading-state.ps1` | reading-state validator |

### Requirements

- **Base**: Windows, PowerShell 7, Python 3.11 or later.
- **Agent runtime**: Codex CLI, or Claude Code together with the matching Codex version.
- **PDF**: a Python with `pypdf` at `<DEEPBOOKER_HOME>\.deepbooker-work\documents-runtime\`.
- **Other people's tools** (not bundled; install each by its own instructions):
  - [nlpm](https://github.com/xiaolai/nlpm), for the quality review before an Agent is written;
  - the XROS method plugin, used in the report's research stage;
  - Office CLI, for the Word file.

### Install (copy the files to these places)

| From | To |
|---|---|
| `codex/agents/*.toml` | `%USERPROFILE%\.codex\agents\` |
| `claude/agents/*.md` | `%USERPROFILE%\.claude\agents\` (optional, for Claude) |
| `agent-support/a-deepbooker`, `agent-support/a-book` | `%USERPROFILE%\.codex\agent-support\` |
| `plugins/deepbooker` | `<DEEPBOOKER_HOME>\plugins\deepbooker` |
| `tools/validate-reading-state.ps1` | `<DEEPBOOKER_HOME>\.deepbooker-work\` |

**Copy the files unchanged**: `dependencies.json` pins their SHA-256. If any of them is changed, the runtime reports `dependency drift requires review` and stops.

### Settings

| Variable | Purpose | Default |
|---|---|---|
| `DEEPBOOKER_HOME` | Deepbooker's working folder (skill, reports, Word, work files) | `%USERPROFILE%\Documents\Deepbooker` |
| `DEEPBOOKER_READY_DIR` | where the finished Word copy is placed | `%USERPROFILE%\Documents\READY TO READ` |

- **Model**: a-deepbooker and a-book do not pin a model; they use your Codex default.
- **Generated book Agents**: they default to `gpt-5.6-sol` with reasoning effort `xhigh`; change this in the request.

### Check the installation

From `%USERPROFILE%\.codex\agent-support`:

```powershell
'{"op":"dependencies"}' | Set-Content req.json
python -X utf8 -B a-deepbooker\runtime.py --request req.json
```

`"status": "READY"` means the installation is complete.

### Notes

- **Time**: a book usually takes several hours.
- **Approvals in the terminal**: the run creates Agent files, a knowledge package, reports and a Word file, and asks you to approve its steps in the terminal.
- **Source books**: use only books you lawfully own. There are no private-book uploads, no DRM bypass and no purchases.

## License

MIT © 2026 deepcoder888 (see the repository's `LICENSE`).
