# mdterm

[English](README.md) | [简体中文](README_CN.md)

> 一款直接运行在终端中的快速、只读 Markdown 阅读器，支持键盘、鼠标、搜索和目录导航。

> 本项目由 Codex 端到端驱动开发；维护者负责产品方向与发布验收。

![mdterm 在 Ghostty 中运行](https://raw.githubusercontent.com/uxgnod/mdterm/main/assets/readme/mdterm-hero.png)

截图使用 Ghostty；mdterm 可运行于任何兼容终端。

## 功能

- 全屏只读渲染标题、列表、表格、链接、代码、图片和任务列表。
- 键盘导航、可选鼠标文本选择、持久搜索导航和目录面板。
- 深色与终端两种背景；终端背景使用终端自身的颜色。
- 默认 English，可在当前会话切换简体中文（`zh-CN`）。
- 可见 fenced code 块提供原始代码复制按钮，包括常见列表和引用嵌套。
- 仅在同一可见片段内 Ctrl-click 才打开安全的 `http`/`https` 链接。
- 大 Markdown 文件使用有界的轻量渲染路径。

## 环境要求

- Node.js 18 或更高版本
- 交互式终端

## 安装

从已发布的 npm 包安装：

```bash
npm install -g mdterm
md README.md
```

从源码安装：

```bash
npm install
npm run build
npm install -g .
```

`md` 与 `mdview` 功能和参数完全相同。若 `md` 与 shell 命令冲突，推荐使用 `mdview`。

### `md` 与 shell alias 冲突

Oh My Zsh 常把 `md` 定义为 `mkdir -p` 的 alias。修改前先检查：

```bash
type -a md
alias md

\md README.md       # 本次调用绕过 alias
mdview README.md    # 无冲突备选命令
unalias md          # 只移除当前 shell 的 alias
command md README.md
```

如果 `type -a md` 显示的是 function 而不是 alias，`\md` 只能绕过 alias；请使用 `command md FILE` 或 `mdview FILE`。

永久处理：在 Oh My Zsh 加载之后把下面一行放入 `~/.zshrc`，然后重开 shell 或执行 `source ~/.zshrc`：

```bash
unalias md 2>/dev/null
```

Windows Command Prompt 和 PowerShell 也可能把 `md` 作为 `mkdir` 的内建命令或 alias，推荐：

```powershell
mdview README.md
```

## 快速开始

```bash
md README.md
mdview README_CN.md
md README.md --toc
md README.md --lang zh-CN
md README.md --no-mouse
```

## CLI 选项

```text
md <file.md> [--no-mouse] [--toc] [--lang en|zh-CN]
mdview <file.md> [--no-mouse] [--toc] [--lang en|zh-CN]

--no-mouse  禁用应用鼠标输入，使用终端原生文本选择
--toc       启动时打开目录
--lang      使用 English 或简体中文
-h, --help  显示帮助
-v, --version  显示版本
```

文件必须是可读取的 UTF-8 普通文件。`md` 与 `mdview` 的错误会使用实际命令名作为前缀。

## 键盘与鼠标

| 操作 | 键位或手势 |
| --- | --- |
| 滚动 | `↑` / `k`、`↓` / `j` |
| 半屏滚动 | `PgUp` / `PgDn`、`Ctrl+u` / `Ctrl+d` |
| 顶部 / 底部 | `gg` / `G` |
| 搜索 | `/`，Enter 确认 |
| 下一个 / 上一个匹配 | `n` / `p`；`N` 兼容 |
| 清除 | `Esc`（先选区，后已确认搜索） |
| 目录 | `t`，再用 `↑` / `↓` 和 Enter |
| 正文 / 目录焦点 | `Tab` |
| 文本选择模式 | `m`：开启 → 自动复制 → 关闭 → 开启 |
| 复制手动选区 | `y` |
| 帮助 | `?`，再按任意键 |
| 退出 | `q` / `Ctrl+c` |

鼠标可用时默认是 `文本选择:开启`：拖拽会选取文本，但 mouseup 不会自动复制。`自动复制` 会在释放鼠标后复制，`关闭` 禁用应用内选取。`--no-mouse` 或终端能力降级时显示 `文本选择:终端原生`，不会展示应用内 `m`/`y` 动作。

代码按钮和应用内文本选择需要鼠标。普通点击用于文本选择。只有终端上报修饰键，并且 Ctrl-左键按下与释放处于同一可见链接片段内时，才会打开链接。Cmd-click 仅尽力支持，不是跨终端保证。

## 搜索

`/` 会实时搜索。Enter 关闭输入框，底栏变成持久导航栏：

![mdterm 搜索导航](https://raw.githubusercontent.com/uxgnod/mdterm/main/assets/readme/mdterm-search.png)

```text
搜索 “keyword” · 3/17 · n 下一个 · p 上一个 · / 修改 · Esc 清除
```

搜索不区分大小写，并把 Unicode 大小写折叠后的匹配映射回原始 grapheme 边界，因此 `İ`、组合字符、emoji 和 CJK 不会被切开。当前匹配使用粗体、下划线和亮色或终端原生前景色，不使用反色或搜索背景。渲染器模型可以包含 overline，但 neo-blessed 实际终端会自然降级为它支持的样式。

## 背景与语言

按 `b` 在 `背景:深色` 与 `背景:终端` 之间切换，不执行系统主题探测，也不修改终端颜色。

按 `l` 打开可搜索语言弹窗。弹窗中输入的 `q`、`b`、`m` 只是过滤文本，不触发全局动作。Enter 应用当前语言，Esc 取消。语言切换立即影响当前会话，并在从弹窗应用后保存为下次启动偏好。

## 持久化偏好

阅读器只在以下位置保存非敏感用户偏好：

```text
~/.config/mdterm/config.json
```

首次启动会创建：

```json
{
  "language": "en",
  "background": "dark",
  "selectionMode": "manual"
}
```

优先级为 `当次 CLI 明确选项 > 合法配置值 > 内置默认值`。`--lang` 只对本次进程生效，除非随后在语言弹窗中应用新的语言。`--no-mouse` 是运行时能力选项，不会修改已保存的文本选择模式。`--toc`、搜索、滚动、TOC 焦点、选区和剪贴板内容都不会持久化。

配置目录和文件在平台支持时使用当前用户私有权限。写入使用同目录临时文件和原子替换，并保留未知 JSON 字段。缺字段或单个字段非法时分别回退；整体损坏或超过 64 KiB 时，若能备份会先生成带时间戳的 `config.json.invalid-*`，再写入默认值。读取、备份或写入失败不会阻断 Markdown 阅读，并显示一次本地化提示。

## 复制与链接

鼠标可用且代码框足够宽时显示 `[复制]`。按钮复制代码 token 原文，保留换行、tab、缩进和尾随空格，不包含 fence、语言名、列表或引用装饰。按钮根据真实后端结果显示 `已复制`、`已发送` 或 `失败`，2 秒后恢复 `[复制]`。

系统剪贴板后端使用异步参数调用和 `shell: false`，上限为 4 MiB。OSC 52 是独立的回退路径，上限为 100 KiB。超时、取消、后端不可用或内容超限均显示失败；退出阅读器时会取消未完成的剪贴板任务。

只允许打开 `http://` 和 `https://` 链接。URL 通过参数数组传给 opener，不经过 shell；异步 opener 错误不会导致阅读器崩溃。不会向 neo-blessed 内容注入 OSC 8。

## 渲染与大文件

![mdterm 渲染 Markdown](https://raw.githubusercontent.com/uxgnod/mdterm/main/assets/readme/mdterm-rendering.png)

- ANSI-aware 宽度计算保留 CJK、组合字符、surrogate pair 和 emoji 边界。
- 表格和长代码行会按终端宽度重新排版。
- 输入中的终端控制字符会在显示前安全处理。
- UTF-8 输入达到 512 KiB 后使用有界轻量渲染并让出事件循环，保留源文本、搜索、滚动和有界标题目录，同时有意减少富文本格式。
- 轻量路径面向多 MiB 文档的有界内存和可退出性，不宣称所有大输入都完整富渲染。

## 已知限制

- 本版本未交付 TOC hover，仅保留键盘和点击路径。代码按钮 hover 属于渐进增强，取决于终端是否报告 mousemove。
- Cmd-click 取决于终端修饰键上报，仅尽力支持。Windows/Linux 系统剪贴板和 opener 在此使用注入测试覆盖，不等同于所有平台的完整实机验收。
- 链接 hitbox 只覆盖当前富渲染视口；大文件轻量模式仍显示 URL，但不建立富文本链接 hitbox。
- 拖拽到视口边缘不会自动滚屏扩选，复制的是渲染文本而不是 Markdown 源码。
- 程序只在启动时读取单个文件，不监听文件变化；没有项目配置、同步、热加载或设置页面。

## 开发

```bash
npm install
npm run typecheck
npm run build
npm test
```

测试使用临时 home 和 fake 剪贴板/opener，不要指向真实用户配置或全局 npm prefix。参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## 由 Codex 驱动开发

Codex 自主完成了程序实现、测试、文档与发布准备；维护者负责产品目标、范围决策与最终质量验收。

## 路线图

编辑、文件监听、富图片、脚注、TOC hover 和设置页面不在 0.5 范围内，当前 CLI 和 README 不暗示这些功能已经实现。

## 许可证

MIT，见 [LICENSE](LICENSE)。
