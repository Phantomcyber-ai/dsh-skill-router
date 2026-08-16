# dsh-skill-router

**意图级技能自动路由插件（DeepSeek Harness）——让 AI 在"该用技能的时候"自动用上技能。**

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/Phantomcyber-ai/dsh-skill-router)](https://github.com/Phantomcyber-ai/dsh-skill-router)
[![release](https://img.shields.io/github/v/release/Phantomcyber-ai/dsh-skill-router)](https://github.com/Phantomcyber-ai/dsh-skill-router/releases)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-收录成功-brightgreen)](https://github.com/AdamPlatin123/awesome-dsh-plugins)

> 深挖一个问题：DSH 会把 `<available_skills>` 技能目录注入上下文，但**是否加载技能完全依赖模型自主判断**。
> 技能一多，模型注意力就会漏掉该用的技能——"该用技能的时候不用"。
> dsh-skill-router 在 `agent/pre-step` 钩子里对每条用户消息做自动路由，命中即把技能全文注入上下文，
> 模型无需再手动调 `skill` 工具。

## 特性

- **两级路由**：中文感知的启发式打分（bigram 切段去虚词 + 拉丁 token 重叠 + 技能名/触发短语命中）零成本快速命中；弱信号才调 LLM 判定（hybrid 模式，默认）
- **复用官方注入管线**：命中即按 `skill-invocation` 源注入技能全文——与 `/技能名` 手势（dsh-tool-skill）完全同一机制，UI 正常展示
- **零侵入**：任何异常都不会阻断 agent 循环（路由失败只意味着退回现状）；不注册任何工具、不占工具目录
- **防误伤**：每 agent 近期已注入技能不重复注入；短消息（继续/嗯）不路由；`/技能名` 手势由官方负责自动跳过
- **与实验预设兼容**：`anchored-standard` 类组合（无 `skill` 加载工具）默认自动让位；全新会话首条消息不注入（保住首轮 Minimal 锚定）

## 工作原理

```
用户消息 → 启发式打分（零 LLM 成本）
            ├─ 强命中(≥minScore) → 直接注入技能全文（不调 LLM）
            └─ 弱信号 → LLM 判定（12s 超时/失败回退启发式第一名）
                    → createUserMessage + skill-invocation 源注入
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
| `llmTimeoutMs` | `12000` | LLM 判定超时 |
| `skipShortMessages` | `true` | "继续/嗯"等短消息不路由 |
| `respectOnDemandPresets` | `true` | anchored-standard 类组合（无 `skill` 工具）默认让位 |

## 与实验预设（anchored-standard / router-standard）的兼容性

| 预设 | 关系 |
| --- | --- |
| 默认 standard | 无冲突：保留 dsh-tool-skill 目录注入，本插件是纯增强 |
| `router-standard` | 无冲突：它做 spec/react 任务模式路由，技能侧保留 dsh-tool-skill |
| `anchored-standard`（及 anchored-wsl） | 默认自动让位：该组合故意移除技能目录注入、改由 `skill_search`/`skill_load` 按需发现，且首轮有 bootstrap 门禁。本插件检测到当前 agent 没有 `skill` 加载工具时默认不注入（`respectOnDemandPresets: true`）；全新会话首条消息也不注入，两条防线共同保住首轮 Minimal 锚定 |

## 实测结果

用真实会话技能目录（17 个技能）做的功能测试（`test-router.mjs`，无 LLM 环境验证启发式路径）：

| 用户消息 | 自动注入 |
| --- | --- |
| 帮我写一份公文 | `official-document-writing` ✓ |
| 给分行党委中心组补全学习记录 | `study-record-filler` ✓ |
| 把这份 PDF 转成 Markdown | `markitdown-skill` ✓ |
| 帮我整理一下今天的工作 | `daily-work-assistant` ✓ |
| 深度调研一下国产大模型市场 | `deep-research` ✓ |
| dsh 打不开了，帮我诊断 | `dsh-maintenance` ✓ |
| 写一份向上级报送的专项报告 | `report-drafting` ✓ |
| 继续 / 嗯 | 跳过（短消息）✓ |
| 知乎搜索 / 找海报技能 / 网页截图 | 弱信号 → 生产环境由 LLM 判定 ✓ |

## 开发

```bash
# 功能测试（模拟 agent/pre-step，用真实技能目录）
node test-router.mjs
# 打分调试
node debug-scoring.mjs
```

依赖：`@deepseek-ai/dsh-llm`（createUserMessage、ctx.llm.stream）、`@deepseek-ai/dsh-skill`（ctx.skills.snapshot/get、renderSkillContent、isModelInvocable）、`@deepseek-ai/schemastery`（Config）。

## License

MIT
