# dsh-anchored-flash

[English](./README.md) | 中文

实验性的 DeepSeek Harness agent 预设：**Minimal 对齐锚定 + 晋升后低注入 + 间接 AGENTS.md 加载 + 子代理锚定**——即"锚定智力不降智"实验系列。

基于 [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) 的定制分支；完整实验报告见[上游 issue #49](https://github.com/xiaobright/dsh-anchored-standard/issues/49)。

> **维护状态（2026-08-17）**：上游
> [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)
> 已进入维护模式（FAREWELL——官方 API 价格变动使该实验系列成本过高）。
> 本仓库作为该系列的实验分支**保持冻结**：不再随上游演进，实验结论存档于
> [上游 issue #49](https://github.com/xiaobright/dsh-anchored-standard/issues/49)。
> 相关工作已迁移至 `zhu1090093659/dsh-web-ui` 生态（AGENTS.md 非强制提示
> instructionHint 已并入 #388）。本地安装与使用不受影响；本仓库不再计划新发布。

## 与上游的差异

| 特性 | 上游 `anchored-standard` | 本预设 |
|---|---|---|
| 首轮请求 | Minimal 工具对 `bash` + `str_replace_editor`、maxTokens 1024、零注入上下文 | 相同 |
| 晋升后 system prompt | `complete: true` persona，全程保持 Minimal 一句（46 字符） | 相同，由 `tool-bootstrap` 的 assemble 过滤器在每阶段强制 |
| 晋升后工具目录 | bootstrap 对 + 发现工具 + `dev_tool_search` 解锁 | 可配置 **`residentTools` 白名单**（默认 18 个工具，含 memory/dtodo/web_search/de_session/read_image/exit_plan_mode/skill_search/skill_load） |
| `instruction-hint` 措辞 | 命令式（"read the relevant instruction files **first and follow them**"）——**实测会把锚定轨迹打回 "let me"** | 中性/建议式参考声明——**实测保持 "we"**（见下方实验表） |
| 子代理 | 可选 `includeSubagents` | **默认 `true`**——子代理走同一套锚定流程 |
| AGENTS.md | 全量 digest 注入（扰动轨迹）或完全不注入 | **间接注入**：1KB 主题索引 + `AGENTS-*.md` 主题分册 + `env-*` 技能，按需加载（`skill_load` / `read`）——实测不扰动 |
| Windows bash | `custom-bash`（固定路径） | `custom-bash` + **PATH 回退**（配置路径失效时自动查找） |
| runtime context（记忆快照等） | 剥离 | 每阶段都剥离（低注入） |

## 实验摘要（2026-08-16 实测，DeepSeek V4 Pro，reasoningEffort=max）

指纹 = 完整 reasoning 文本中 `we` / `let's` / `let me` 的出现次数（大小写不敏感、整词匹配）。会话均为 Windows + rc.6 上的真实 DSH 会话。

| 实验 | Hint 措辞 | System prompt | 结果 |
|---|---|---|---|
| 基线 | 命令式（"read first and follow them"） | 恢复为 standard（46→6620 字符） | **晋升后 we→let me 翻转**（0 we / 3 let me；模型："I must read relevant instructions"） |
| E1 | 中性参考声明 | 全程 46 字符 | `we` 保持（22.5k 字符分析中最高 49 we / 1 let me） |
| E2 | 中性 + 用户要求读 AGENTS.md | 全程 46 字符 | 走完整按需链路（`skill_search` → `skill_load` → `read` 1KB 索引）；`we` 保持；环境事实被真正使用 |
| E1.5 | 建议式（"reading the index is recommended"） | 全程 46 字符 | `we` 保持；模型仅在任务需要环境事实时读取 |

关键结论：

1. **晋升后的 system prompt 突变（46→6620 字符）本身就是扰动源。** system prompt 每阶段都保持 Minimal 那一句。
2. **user 角色注入消息中的命令式措辞与风格切换相关**（我们只报告相关性，不宣称机制）。
3. **非命令式参考措辞不会翻转轨迹**，读取意愿由任务需求驱动，与 hint 措辞无关。
4. **锚定智力与 AGENTS.md 可用性并不互斥**：用非命令方式告知模型参考文档存在，让它按需加载即可。

## 安装

```powershell
$target = Join-Path $env:USERPROFILE '.dsh\.agent-presets\anchored-flash'
if (Test-Path -LiteralPath $target) { throw "Preset already exists: $target" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item -Recurse -LiteralPath '.\preset' -Destination $target
```

重启 DeepSeek Harness，新建会话，选择 **锚定标准·满血子代理**（`anchored-flash`）。不要在会话中途切换预设。

### 推荐的 AGENTS.md 布局（间接注入模式）

把用户全局 `~/.dsh/AGENTS.md` 拆成：

- `~/.dsh/AGENTS.md` — ~1KB 主题索引（3 条铁律 + 指向分册的索引表）
- `~/.dsh/AGENTS-<主题>.md` — 主题分册（environment / network / dsh / workflow / browser …）
- `~/.dsh/skills/env-*` — 同内容的技能版，经 `skill_search` 发现、`skill_load` 按需加载

## 验证

```sh
node verify/verify-anchored-flash.mjs      # 18 项逻辑自测，无需 DSH 运行时
node verify/trace-session.mjs <会话目录>    # header + 思维链指纹追踪
node verify/count-pronouns.mjs <会话目录>   # we / let's / let me 计数
node verify/dive-session.mjs <会话目录>     # 完整 system + 消息来源
node verify/dump-session.mjs <会话目录>     # header + 首行 dump
```

## 许可证

MIT。本预设基于 DeepSeek Harness Standard 预设与 `xiaobright/dsh-anchored-standard` 修改而来；见 [`NOTICE`](./NOTICE) 与 [`LICENSE`](./LICENSE)。部分实验设计与本文档由 DeepSeek（AI 助手）协助完成；所有测量数据均来自真实 DSH 会话。
