# dsh-skill-router

**意图级技能自动路由插件（DeepSeek Harness）——让 AI 在"该用技能的时候"自动用上技能。**

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/Phantomcyber-ai/dsh-skill-router)](https://github.com/Phantomcyber-ai/dsh-skill-router)
[![release](https://img.shields.io/github/v/release/Phantomcyber-ai/dsh-skill-router)](https://github.com/Phantomcyber-ai/dsh-skill-router/releases)

> 深挖一个问题：DSH 会把 `<available_skills>` 技能目录注入上下文，但**是否加载技能完全依赖模型自主判断**。
> 技能一多，模型注意力就会漏掉该用的技能——"该用技能的时候不用"。
> dsh-skill-router 在 `agent/pre-step` 钩子里对每条用户消息做自动路由，命中即把技能全文注入上下文，
> 模型无需再手动调 `skill` 工具。

## 特性

- **三级路由**：中文感知的启发式打分（bigram 切段去虚词 + 拉丁 token 重叠 + 技能名/触发短语命中）零成本快速命中；强命中全文注入，弱信号交 LLM 判定（hybrid 模式，默认），LLM 未命中时弱信号带按 `weakForm` 回退——默认注入**摘要发现块**而非全文（吸收 dsh_cot_gw_dyn skill-search 的"发现/加载分离"思想）
- **复用官方注入管线**：全文命中按 `skill-invocation` 源注入技能全文——与 `/技能名` 手势（dsh-tool-skill）完全同一机制，UI 正常展示
- **零侵入**：任何异常都不会阻断 agent 循环（路由失败只意味着退回现状）；不注册任何工具、不占工具目录
- **防误伤**：每 agent 近期已注入技能不重复注入；短消息（继续/嗯）不路由；`/技能名` 手势由官方负责自动跳过
- **与实验预设兼容**：`anchored-standard` 类组合（无 `skill` 加载工具）默认自动让位；**cot 系预设（cot-gw / cot-dyn）自动识别**——组合存在 `skill_load`/`skill_search` 等按需通道时视为可路由，自动注入与按需发现并存；全新会话首条消息不注入（保住首轮 Minimal 锚定）
- **千人千面（v0.4）**：首次路由自动扫描当前环境**实际存在**的技能目录与 MCP 工具面（`ctx.tools.schemas` 枚举 `mcp__<server>__<tool>`）落盘个人基线并周期刷新；弱信号发现块按消息附带匹配的 MCP 工具提示，live 目录不完整时以基线回退

## 工作原理

```
用户消息 → 启发式打分（零 LLM 成本）
            ├─ 强命中(≥minScore) → 直接注入技能全文（不调 LLM）
            └─ 弱信号 → LLM 判定（12s 超时/失败回退弱信号带）
                    ├─ 判定命中 → 注入技能全文（createUserMessage + skill-invocation 源）
                    └─ 回退按 weakForm ─ summary：紧凑摘要发现块（默认）
                                        ├ full：全文回退（v0.2 行为）
                                        └ none：不注入
```

注入发生在 `agent/pre-step`（与 dsh-tool-skill 同一事件、同一注入管线），模型在同一个 step 就能看到技能正文并直接使用。

## 安装

### 方式一：运行时注入（dsh-super-injector）

```bash
dev_inject_plugin <本仓库目录>
```

### 方式二：profile bundles（持久）

在 profile `package.json` 的 `dependencies` 加 `link:` 依赖、`bundles` 数组加包名，重启即装配（见 [dsh-super-injector](https://github.com/ysr666/dsh-super-injector) 文档）。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `mode` | `hybrid` | `hybrid` / `heuristic`（零 LLM）/ `llm`（全判定） |
| `llmProvider` / `llmModel` | 空 | 指定判定模型；留空自动选第一个可用 provider |
| `maxSkillsPerMessage` | `2` | 每条消息最多注入技能数 |
| `minScore` | `0.5` | 启发式强命中阈值 |
| `weakForm` | `summary` | 弱信号带（LLM 未判定命中）的回退形态：`summary` 注入紧凑摘要发现块（技能名 + 一行描述 + `/name` 手势引导；`plugin` 源，不占全文防重名单，后续强命中可升级全文）；`full` 回退注入全文（v0.2 行为）；`none` 不注入 |
| `personalBaseline` | `true` | 首次安装/首次路由扫描当前环境技能目录 + MCP 工具面，落盘个人基线并周期刷新（千人千面） |
| `hintMcpTools` | `true` | 弱信号发现块中包含按消息匹配的 MCP 工具（`mcp__<server>__<tool>`，来自基线扫描） |
| `baselineRefreshHours` | `24` | 基线刷新周期（小时），到期后下一次路由触发重扫；删除基线文件可立即重扫 |
| `baselineDir` | 空 | 基线落盘目录；留空 = `<DSH_HOME|~/.dsh>/plugins/dsh-skill-router/`（按 cwd 哈希分文件） |
| `llmTimeoutMs` | `12000` | LLM 判定超时 |
| `skipShortMessages` | `true` | "继续/嗯"等短消息不路由 |
| `respectOnDemandPresets` | `true` | 组合无任何技能加载/发现通道（严格 on-demand，如 anchored-standard）时让位；**存在 `skill` 或 `onDemandLoaderTools` 中任一工具（standard / cot-gw / cot-dyn）时正常自动路由** |
| `onDemandLoaderTools` | `['skill_load', 'skill_search']` | 视为"已提供按需技能通道"的工具名；cot 类预设的 skill_load / skill_search 命中即默认开启路由。**至少 1 个**（空数组为无效配置：装配校验失败；程序化直调时自动回退默认值） |

## 与 cot 系预设（cot-gw / cot-dyn）整合

[dsch_cot_gw_dyn](https://github.com/CZM1998/dsh_cot_gw_dyn) 的思维链保护预设移除了 9KB 技能目录注入、改由 `skill_search`/`skill_load` 按需发现。两者互补：cot 系解决"能力可达、请求面收敛"，本插件解决"模型该用技能时漏用"。本插件升级版（v0.2）自动识别该系预设并正常路由，无需手动改配置。

**v0.3 进一步吸收其 skill-search 的「发现/加载分离」思想**：cot 实验证明大块全文/目录注入会扰动轨迹，因此本插件在弱信号带（打分偏低且 LLM 未判定命中）默认不再回退注入数 KB 全文，而是注入一个紧凑的 `<skill_hints>` 摘要块（技能名 + 一行描述 + `/name` 手势引导），由模型自行决定是否加载全文——与 `skill_search` 的"摘要发现、按需加载"同一哲学，但保持**零工具注册**。需要旧行为可设 `weakForm: 'full'`。

**cot-dyn 推荐装配**（preset 内嵌，见 dsh_cot_gw_dyn 的整合说明）：

```yaml
- id: skill-router
  name: 'dsh-skill-router'
  disabled: true   # 默认禁用：未安装该包时预设照常可用；安装包后删除此行（或改 false）
  config:
    respectOnDemandPresets: true   # 自动识别（cot-dyn 挂载了 skill_load，默认即开启路由）
    onDemandLoaderTools: ['skill_load', 'skill_search']
    maxSkillsPerMessage: 1         # 思维链保护：一次只注入一个技能全文
    weakForm: 'summary'            # 弱信号只给摘要发现块，不塞全文（v0.3 默认值，显式写出便于回退 full）
    mode: hybrid
```

> 安全设计：preset 内嵌行默认 `disabled: true`——DSH 装配时完全跳过 disabled 行（不解析包），因此未安装 dsh-skill-router 的机器上预设照常挂载；安装包后删除该字段即可启用。

> 注：cot-gw 的请求面不含 skill 工具（仅 gateway 可转发），router 的自动注入是其技能可达的补强通道；如希望 cot-gw 保持"零注入"纯度，可对该会话设 `enabled: false`（或注入时不启用该插件行）。

## 首次安装：千人千面环境扫描（v0.4）

插件不假设任何固定技能清单。**首次路由时扫描当前环境实际存在的能力面**，落盘为个人基线：

- **技能目录**：`ctx.skills.snapshot()`（name / description / whenToUse / 可调用性）；
- **MCP 工具**：`ctx.tools.schemas()` 枚举 `mcp__<server>__<tool>` 注册名与描述；
- **基线文件**：`<DSH_HOME|~/.dsh>/plugins/dsh-skill-router/baseline-<cwd哈希>.json`，默认 24h 周期刷新（删除文件即可触发重扫）。

基线用途：

1. **MCP 工具发现**：弱信号发现块按消息打分（与技能同一套中文感知启发式），把匹配的 MCP 工具（`mcp__github__search_issues: …`）附进 `<skill_hints>`——每个用户看到的是**自己环境里真有**的工具与技能，而非通用假设；`hintMcpTools: false` 可关闭。
2. **目录回退**：live 技能目录不完整（`snapshot.complete=false`，如装配早期/热刷新窗口）时以基线技能作候选，路由不空转；全文仍经 `ctx.skills.get` 现取。

所有扫描/落盘失败都会静默降级（无 `schemas` 方法的旧内核 → MCP 提示自动缺席），绝不阻断 agent 循环；`personalBaseline: false` 可整体关闭。

## 与实验预设（anchored-standard / router-standard）的兼容性

| 预设 | 关系 |
| --- | --- |
| 默认 standard | 无冲突：保留 dsh-tool-skill 目录注入，本插件是纯增强 |
| `router-standard` | 无冲突：它做 spec/react 任务模式路由，技能侧保留 dsh-tool-skill |
| `anchored-standard`（及 anchored-wsl） | 默认自动让位：该组合故意移除技能目录注入、改由 `skill_search`/`skill_load` 按需发现，且首轮有 bootstrap 门禁。本插件检测到当前 agent 没有 `skill` 加载工具时默认不注入（`respectOnDemandPresets: true`）；全新会话首条消息也不注入，两条防线共同保住首轮 Minimal 锚定 |
| **cot-gw / cot-dyn（思维链保护预设）** | **自动识别、正常路由**：该系组合没有 `skill` 工具，但挂载了 `skill_load`/`skill_search` 按需通道（`onDemandLoaderTools` 默认命中）。自动注入的仅是 user 文本（不触碰请求工具面），与 cot 系"请求面收敛 + 文本注入不影响思维链"的实验结论兼容；首条消息仍跳过，保住锚定 |

## 实测结果

**兼容性**：同一套 18 场景驱动在三个内核上全量通过——已装 `0.1.2-alpha.1`（junction 真实依赖）、`0.1.2-alpha.3` 与最新 `0.1.2-alpha.5`（registry 官方包离线组装）。v0.4.1 适配 alpha.4 的 breaking change：`Session.events` 被按需读取 API（`snapshotEvents()`/`eventAt(seq)`）取代，首条消息检测优先走新 API，旧内核自动回退 `events` 数组，读取失败保守放行。

用真实会话技能目录（17 个技能）做的功能测试（`test-router.mjs`，无 LLM 环境验证启发式路径）：

| 用户消息 | 自动注入 |
| --- | --- |
| 帮我写一份公文 | `official-document-writing` ✓ |
| 把这份 PDF 转成 Markdown | `markitdown-skill` ✓ |
| 帮我整理一下今天的工作 | `daily-work-assistant` ✓ |
| 深度调研一下国产大模型市场 | `deep-research` ✓ |
| dsh 打不开了，帮我诊断 | `dsh-maintenance` ✓ |
| 写一份向上级报送的专项报告 | `report-drafting` ✓ |
| 用 gh 查一下这个 PR | `github` ✓ |
| 继续 / 嗯 | 跳过（短消息）✓ |
| B站视频转文字 / 知乎搜索 / 找海报技能 / 网页截图 | 弱信号 → LLM 判定；未命中时摘要发现块（`weakForm: summary` 默认）✓ |

## 开发

```bash
# 功能测试（模拟 agent/pre-step，用真实技能目录）
node test-router.mjs
# 升级验证：cot 系预设（含 skill_load 无 skill）自动识别 + 路由注入（20 项断言）
node test-integration.mjs
# 冒烟测试：用 DSH 真实依赖（schemastery/dsh-llm/dsh-skill）真实加载并跑关键路径（18 项）
node smoke.mjs
# 打分调试
node debug-scoring.mjs
```

> `smoke.mjs` 需要能解析 `@deepseek-ai/*` 依赖（在 DSH 运行时 node_modules 可见处运行，本机通过 `node_modules` junction 指向 DSH 安装目录）。

依赖：`@deepseek-ai/dsh-llm`（createUserMessage、ctx.llm.stream）、`@deepseek-ai/dsh-skill`（ctx.skills.snapshot/get、renderSkillContent、isModelInvocable）、`@deepseek-ai/schemastery`（Config）。

## License

MIT
