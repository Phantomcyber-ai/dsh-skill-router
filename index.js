/**
 * dsh-skill-router — 意图级技能自动路由插件。
 *
 * 问题：DSH 的 `<available_skills>` 目录只依赖模型自主判断去调用 `skill` 工具，
 * 技能一多模型注意力就会漏，"该用技能的时候不用"。
 *
 * 方案：在 `agent/pre-step` 钩子里对最新用户消息做路由——
 * 1. 启发式快速打分（中文 bigram + 拉丁 token 重叠 + 技能名/触发短语命中）；
 * 2. 强命中直接注入全文；弱信号交给 LLM 判定（hybrid 模式）；LLM 不可用/失败
 *    时弱信号带按 `weakForm` 回退：summary（默认，吸收 dsh_cot_gw_dyn skill-search
 *    的"发现/加载分离"思路）注入紧凑摘要提示而非全文，full 注入全文，none 关闭；
 * 3. 全文命中以 `skill-invocation` 源注入上下文（与 `/技能名` 手势同一机制，
 *    复用 dsh-tool-skill 的注入管线），模型无需再调用 skill 工具。
 * 4. on-demand 预设识别升级：`respectOnDemandPresets` 不再只看 `skill` 工具——
 *    组合里存在 `skill_load`/`skill_search` 等按需通道（cot-gw / cot-dyn 等预设）
 *    时视为可路由组合，自动注入与按需发现并存；两者皆无（严格 on-demand，如
 *    anchored-standard）才让位跳过，避免破坏其零技能上下文设计。
 * 5. 千人千面：首次安装/首次路由扫描当前环境的技能目录与 MCP 工具面
 *    （ctx.tools.schemas 枚举 mcp__<server>__<tool>）落盘个人基线并周期刷新；
 *    弱信号发现块按消息补充匹配的 MCP 工具提示，live 目录不完整时以基线回退。
 *
 * 任何异常都不会阻断 agent 循环（路由失败只意味着退回现状）。
 */
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-skill-router'
export const inject = ['skills', 'tools']

export const Config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /**
   * 路由模式：
   * - hybrid（默认）：启发式强命中直接注入；弱信号才调 LLM 判定；
   * - heuristic：只用启发式，零 LLM 成本；
   * - llm：一律交 LLM 判定（慢、贵，仅用于调优）。
   */
  mode: z.string().default('hybrid'),
  /** 指定 LLM 路由（provider/model）；留空自动选第一个可用 provider 的模型。 */
  llmProvider: z.string().default(''),
  llmModel: z.string().default(''),
  /** 每条用户消息最多自动注入几个技能。 */
  maxSkillsPerMessage: z.number().default(2),
  /** 启发式"强命中"阈值（0~1），高于它不再调 LLM。 */
  minScore: z.number().default(0.5),
  /** LLM 判定超时（毫秒），超时回退启发式。 */
  llmTimeoutMs: z.number().default(12000),
  /** 过短的消息（继续/嗯/好的）不路由，避免无谓 LLM 调用。 */
  skipShortMessages: z.boolean().default(true),
  /**
   * 尊重 on-demand 预设：该流派（anchored-standard / cot-gw / cot-dyn）刻意移除
   * 技能目录注入，改由模型用 skill_search/skill_load 按需发现。
   * 判定规则（任一条件满足即视为"已提供技能通道"，正常自动路由；全部不满足才让位）：
   * - 存在传统 `skill` 加载工具（dsh-tool-skill 挂载，standard 类组合）；
   * - 存在 `onDemandLoaderTools` 中的任一工具（cot 类预设的 skill_load / skill_search）。
   * 置 false 强制注入。
   */
  respectOnDemandPresets: z.boolean().default(true),
  /** on-demand 组合中"已提供按需技能通道"的工具名（任一存在即视为可路由的预设）。
   * 至少 1 个；空数组视为配置无效（装配时校验失败）。 */
  onDemandLoaderTools: z.array(z.string()).min(1).default(['skill_load', 'skill_search']),
  /**
   * 弱信号带（0 < 得分 < minScore 且 LLM 未判定命中）的回退注入形态——吸收
   * dsh_cot_gw_dyn skill-search 的"发现/加载分离"思路（大块全文注入扰动轨迹）：
   * - summary（默认）：注入紧凑的技能提示块（name + 一行描述 + /name 手势引导），
   *   让模型廉价地"发现"技能再决定是否加载；不占全文防重名单，后续强命中可升级全文；
   * - full：直接注入第一名技能全文（v0.2 行为）；
   * - none：弱信号带不注入（最严格）。
   */
  weakForm: z.string().default('summary'),
  /**
   * 千人千面：首次安装/首次路由时扫描当前环境的技能目录与 MCP 工具面
   * （ctx.tools.schemas 枚举 mcp__<server>__<tool>），落盘为个人基线并周期刷新。
   * 用途：①弱信号发现块补充按消息匹配的 MCP 工具提示；②live 技能目录不完整
   * （snapshot.complete=false）时以基线技能作候选回退（全文仍经 ctx.skills.get 现取）。
   */
  personalBaseline: z.boolean().default(true),
  /** 基线刷新周期（小时）；到期后下一次路由触发重扫。 */
  baselineRefreshHours: z.number().default(24),
  /** 基线落盘目录；留空 = <DSH_HOME|~/.dsh>/plugins/dsh-skill-router/。 */
  baselineDir: z.string().default(''),
  /** 弱信号发现块是否包含按消息匹配的 MCP 工具（依赖基线扫描结果）。 */
  hintMcpTools: z.boolean().default(true),
  /** 注入时写日志。 */
  verbose: z.boolean().default(true),
})

const DEFAULT_CONFIG = {
  enabled: true,
  mode: 'hybrid',
  llmProvider: '',
  llmModel: '',
  maxSkillsPerMessage: 2,
  minScore: 0.5,
  llmTimeoutMs: 12000,
  skipShortMessages: true,
  respectOnDemandPresets: true,
  onDemandLoaderTools: ['skill_load', 'skill_search'],
  weakForm: 'summary',
  personalBaseline: true,
  baselineRefreshHours: 24,
  baselineDir: '',
  hintMcpTools: true,
  verbose: true,
}

/** 与 dsh-tool-skill 同一 `/name` 手势语法：手势命中的技能由它负责注入，路由跳过。 */
const GESTURE_RE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

const CJK_RE = /[\u4e00-\u9fff]+/g
const LATIN_RE = /[a-z0-9]+(?:-[a-z0-9]+)*/gi

/** 中文虚词/语气词开头的大多是辅助性 bigram（帮我/这个/一下…），不参与打分。 */
const STOP_FIRST_CHARS = new Set(
  '的了吗吧呢呀嘛啊哦嗯帮把被在是有人我你他她它这那就不很都也还和与或及请想给让对从到向于为着过个',
)
/** 整词停用（常见口语虚词短语）。 */
const STOP_BIGRAMS = new Set([
  '帮我', '一下', '看看', '这个', '那个', '什么', '怎么', '可以', '麻烦', '需要',
  '一个', '一份', '一次', '一篇', '这些', '那些', '咱们', '我们', '你们', '他们',
  '自己', '的话', '好吗', '好不', '快点', '马上', '的话', '这种', '那种', '这么', '那么',
])

/** 从消息批次中提取用户直接输入（source.kind === 'user'）的全部文本。 */
function collectUserText(messages) {
  const parts = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text' && block.text) parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** 提取消息里的 `/name` 手势技能名（去重）。 */
function gestureSkillNames(text) {
  const names = []
  for (const match of text.matchAll(GESTURE_RE)) {
    if (!names.includes(match[2])) names.push(match[2])
  }
  return names
}

/**
 * 中文分词近似：CJK 段取 2-gram，ASCII 词按 kebab 拆分。
 * `noiseFilter` 用于用户消息侧：先按停用 bigram（帮我/一下/这个…）切段，再剔除
 * 虚词开头 bigram，最后丢弃单字残留——避免停用词剔除后留下跨界垃圾（理一/份公）。
 * 技能描述侧不做过滤（目录文本里的词都要能命中）。
 */
function collectTokens(text, noiseFilter = false) {
  const tokens = new Set()
  for (const run of text.match(CJK_RE) || []) {
    if (!noiseFilter) {
      if (run.length === 1) {
        tokens.add(run)
        continue
      }
      for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2))
      continue
    }
    let segments = [run]
    for (const stop of STOP_BIGRAMS) {
      if (segments.every((segment) => !segment.includes(stop))) continue
      segments = segments.flatMap((segment) => segment.split(stop).filter(Boolean))
    }
    for (const segment of segments) {
      if (segment.length < 2) continue
      for (let i = 0; i + 1 < segment.length; i += 1) {
        const bigram = segment.slice(i, i + 2)
        if (STOP_FIRST_CHARS.has(bigram[0])) continue
        tokens.add(bigram)
      }
    }
  }
  for (const word of text.match(LATIN_RE) || []) tokens.add(word.toLowerCase())
  return tokens
}

/** 单技能启发式得分：token 重叠占比 + 技能名命中加分 + whenToUse 触发短语加分。 */
function scoreSkill(skill, messageTokens, messageText) {
  const text = `${skill.name} ${skill.description} ${skill.whenToUse ?? ''}`
  const skillTokens = collectTokens(text)
  let hit = 0
  let weight = 0
  for (const token of messageTokens) {
    const w = token.length >= 4 ? 2 : 1
    weight += w
    if (skillTokens.has(token)) hit += w
  }
  if (weight === 0) return 0
  let score = hit / weight
  // 技能 id 的组成部分直接出现在消息里（如 "markitdown"、"pdf"）
  for (const part of skill.name.split('-')) {
    if (part.length >= 3 && messageText.toLowerCase().includes(part)) {
      score += 0.45
      break
    }
  }
  // whenToUse 里的触发短语整句命中（逗号/句号切分后 ≥4 字）
  if (skill.whenToUse) {
    for (const raw of skill.whenToUse.split(/[，。；、,;\n]/)) {
      const phrase = raw.trim()
      if (phrase.length >= 4 && messageText.includes(phrase)) {
        score += 0.4
        break
      }
    }
  }
  return score
}

/** 启发式路由：返回按得分降序的技能名列表。 */
function heuristicPick(text, candidates, config) {
  const messageTokens = collectTokens(text, true)
  const scored = candidates
    .map((skill) => ({ skill, score: scoreSkill(skill, messageTokens, text) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored
}

/** 组 LLM 判定提示词：技能目录（名称+描述）+ 用户消息。 */
function buildRouterPrompt(text, candidates) {
  const lines = candidates.map(
    (skill, index) => `${index + 1}. ${skill.name} — ${skill.description}`,
  )
  return [
    '你是技能路由器。下面列出本会话可用的技能目录（仅名称与一句话描述）。',
    '判断"用户消息"是否明确匹配某个技能：任务类型、主题、关键动作词都与该技能吻合才选。',
    '输出规则：只输出 JSON 数组，如 ["skill-name"]；最多 3 个，按匹配度从高到低；都不匹配输出 []。不要输出任何其他文字。',
    '',
    '<技能目录>',
    ...lines,
    '</技能目录>',
    '',
    '<用户消息>',
    text.slice(0, 2000),
    '</用户消息>',
  ].join('\n')
}

/** 从 LLM 输出中解析技能名（容错：JSON 数组或裸 token 列表），只认目录里的名字。 */
function parseSkillNames(output, candidates) {
  const byName = new Map(candidates.map((skill) => [skill.name, skill]))
  const arrayMatch = output.match(/\[[\s\S]*?\]/)
  const raw = arrayMatch ? arrayMatch[0] : output
  const found = []
  for (const token of raw.match(LATIN_RE) || []) {
    const name = token.toLowerCase()
    if (byName.has(name) && !found.includes(name)) found.push(name)
  }
  return found
}

/** 自动选择 LLM 路由：配置优先，否则第一个能列出模型的 provider。 */
async function resolveRoute(ctx, config) {
  if (config.llmProvider && config.llmModel) {
    return { provider: config.llmProvider, model: config.llmModel }
  }
  const llm = ctx.get('llm')
  if (!llm || typeof llm.listProviders !== 'function') return undefined
  try {
    for (const provider of llm.listProviders()) {
      let models = []
      try {
        models = await llm.listModels(provider.id)
      } catch {
        continue
      }
      if (models.length > 0) return { provider: provider.id, model: models[0].id }
    }
  } catch {
    /* 路由发现失败 → 回退启发式 */
  }
  return undefined
}

/** 一次轻量 LLM 判定：返回命中的技能名列表，失败/超时返回 undefined。 */
async function llmPick(ctx, config, text, candidates, signal) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') return undefined
  const route = await resolveRoute(ctx, config)
  if (!route) return undefined
  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: buildRouterPrompt(text, candidates) }],
      source: { kind: 'plugin', plugin: name },
    }),
  ]
  // 同时受 agent 中止信号与判定超时约束：任一触发即中断 LLM 流
  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(config.llmTimeoutMs)])
  let output = ''
  try {
    for await (const chunk of llm.stream({
      ...route,
      messages,
      temperature: 0,
      maxTokens: 120,
      signal: callSignal,
    })) {
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') return undefined
        break
      }
      if (chunk.type === 'text-delta') output += chunk.text
    }
  } catch {
    return undefined
  }
  const names = parseSkillNames(output, candidates)
  return names.length > 0 ? names : undefined
}

// ---------- 千人千面：环境基线（首次安装扫描技能目录 + MCP 工具面） ----------

const baselineCaches = new Map() // cwd → { data, loadedAt }

function baselineFileFor(config, cwd) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = config.baselineDir || join(dshHome, 'plugins', 'dsh-skill-router')
  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  return join(dir, `baseline-${key}.json`)
}

/** 扫描当前环境：技能目录（name/description/whenToUse）+ MCP 工具面（mcp__* 注册名与描述）。 */
async function scanBaseline(ctx, agent, lookup) {
  const baseline = { version: 1, scannedAt: new Date().toISOString(), cwd: lookup.cwd ?? null, skills: [], mcpTools: [] }
  try {
    const snapshot = await ctx.skills.snapshot(lookup)
    baseline.skills = (snapshot?.skills ?? []).slice(0, 200).map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
      whenToUse: skill.whenToUse ?? '',
      modelInvocable: skill.invocation?.modelInvocable !== false,
    }))
  } catch { /* 目录服务不可用 → 留空，下次到期重扫 */ }
  try {
    if (typeof ctx.tools?.schemas === 'function') {
      baseline.mcpTools = ctx.tools.schemas(agent)
        .filter((schema) => typeof schema?.name === 'string' && schema.name.startsWith('mcp__'))
        .slice(0, 200)
        .map((schema) => ({ name: schema.name, description: schema.description ?? '' }))
    }
  } catch { /* 工具面枚举不可用 → 留空 */ }
  baseline.skillCount = baseline.skills.length
  baseline.mcpCount = baseline.mcpTools.length
  return baseline
}

/** 加载/刷新个人基线：文件缺失或过期时重扫落盘；进程内按 cwd 缓存。任何失败都不阻断路由。 */
async function ensureBaseline(ctx, config, agent, lookup) {
  if (!config.personalBaseline) return undefined
  const cwd = lookup.cwd || '(no-cwd)'
  const cached = baselineCaches.get(cwd)
  const maxAgeMs = config.baselineRefreshHours * 3600000
  if (cached && Date.now() - cached.loadedAt < maxAgeMs) return cached.data
  const file = baselineFileFor(config, cwd)
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch { data = undefined }
  const stale = !data || typeof data.scannedAt !== 'string' || Date.now() - Date.parse(data.scannedAt) > maxAgeMs
  if (stale) {
    try {
      data = await scanBaseline(ctx, agent, lookup)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(data, null, 2))
      if (config.verbose) {
        ctx.logger?.info('[skill-router] 环境基线已扫描: %d 技能 / %d MCP 工具 → %s', data.skillCount, data.mcpCount, file)
      }
    } catch { /* 扫描/落盘失败 → 沿用旧基线或无基线继续 */ }
  }
  if (data) baselineCaches.set(cwd, { data, loadedAt: Date.now() })
  return data
}

/** 每 agent 近期已自动注入的技能（WeakMap，防同技能重复注入）。 */
const injectedRecent = new WeakMap()

function wasInjectedRecently(agent, skillName) {
  const set = injectedRecent.get(agent)
  return set !== undefined && set.has(skillName)
}

function markInjected(agent, skillName) {
  let set = injectedRecent.get(agent)
  if (set === undefined) {
    set = new Set()
    injectedRecent.set(agent, set)
  }
  set.add(skillName)
  if (set.size > 12) {
    const first = set.values().next().value
    if (first !== undefined) set.delete(first)
  }
}

/** 对一条用户消息执行完整路由：返回 { names, form }——form 为注入形态：
 * 'full'（全文，skill-invocation 源）/ 'summary'（摘要发现块，plugin 源）/ 'none'。 */
async function pickSkills(ctx, config, text, candidates, signal) {
  const scored = heuristicPick(text, candidates, config)
  const best = scored[0]
  const topNames = (count) => scored.slice(0, count).map((entry) => entry.skill.name)

  if (config.mode === 'heuristic') return { names: topNames(config.maxSkillsPerMessage), form: 'full' }

  if (best && best.score >= config.minScore) {
    // 强命中：与第一名差距很小的并列技能一起注入，但不超过上限。
    return {
      names: scored
        .filter((entry) => entry.score >= best.score - 0.15)
        .slice(0, config.maxSkillsPerMessage)
        .map((entry) => entry.skill.name),
      form: 'full',
    }
  }

  if (config.mode === 'llm' || (config.mode === 'hybrid' && scored.length > 0)) {
    const fromLlm = await llmPick(ctx, config, text, candidates, signal)
    if (fromLlm !== undefined && fromLlm.length > 0) return { names: fromLlm, form: 'full' }
    // LLM 无匹配或调用失败：弱信号带按 weakForm 回退（吸收 dsh_cot_gw_dyn
    // skill-search 的"发现/加载分离"——摘要发现优先于全文回退，防大块注入扰动）。
    if (best && best.score >= config.minScore * 0.7) {
      if (config.weakForm === 'full') return { names: [best.skill.name], form: 'full' }
      if (config.weakForm === 'summary') return { names: [best.skill.name], form: 'summary' }
    }
  }
  return { names: [], form: 'none' }
}

/**
 * 防御性配置规范化：程序化直调（绕过装配管线的 schemastery 校验）时，
 * 保证关键字段类型/取值合法；非法值回退默认，避免运行期崩溃。
 * 装配管线场景下此函数是幂等的（合法输入原样通过）。
 */
function normalizeConfig(config = {}) {
  const resolved = { ...DEFAULT_CONFIG, ...config }
  if (!Array.isArray(resolved.onDemandLoaderTools) ||
      resolved.onDemandLoaderTools.some((name) => typeof name !== 'string' || name.length === 0)) {
    resolved.onDemandLoaderTools = [...DEFAULT_CONFIG.onDemandLoaderTools]
  } else if (resolved.onDemandLoaderTools.length === 0) {
    resolved.onDemandLoaderTools = [...DEFAULT_CONFIG.onDemandLoaderTools]
  }
  if (typeof resolved.maxSkillsPerMessage !== 'number' || resolved.maxSkillsPerMessage < 1) {
    resolved.maxSkillsPerMessage = DEFAULT_CONFIG.maxSkillsPerMessage
  }
  if (typeof resolved.minScore !== 'number' || resolved.minScore <= 0 || resolved.minScore > 1) {
    resolved.minScore = DEFAULT_CONFIG.minScore
  }
  if (typeof resolved.llmTimeoutMs !== 'number' || resolved.llmTimeoutMs <= 0) {
    resolved.llmTimeoutMs = DEFAULT_CONFIG.llmTimeoutMs
  }
  if (!['hybrid', 'heuristic', 'llm'].includes(resolved.mode)) {
    resolved.mode = DEFAULT_CONFIG.mode
  }
  if (!['summary', 'full', 'none'].includes(resolved.weakForm)) {
    resolved.weakForm = DEFAULT_CONFIG.weakForm
  }
  if (typeof resolved.baselineRefreshHours !== 'number' || resolved.baselineRefreshHours <= 0) {
    resolved.baselineRefreshHours = DEFAULT_CONFIG.baselineRefreshHours
  }
  return resolved
}

function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config)

  ctx.on(
    'agent/pre-step',
    async ({ agent, messages, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || !resolved.enabled) return decision
      try {
        return await routeStep(ctx, resolved, { agent, messages, signal }, decision)
      } catch (error) {
        ctx.logger?.warn('[skill-router] 路由失败，跳过: %s', error instanceof Error ? error.message : String(error))
        return decision
      }
    },
  )
}

/**
 * on-demand 预设识别：该组合是否已提供任何"技能加载/发现通道"。
 * - `skill`（dsh-tool-skill 的传统加载工具）；
 * - `onDemandLoaderTools`（cot 类预设的 skill_load / skill_search 等按需通道）。
 * 两者皆无 → 严格 on-demand（anchored-standard 系）→ respectOnDemandPresets 下让位。
 */
function hasSkillLoader(ctx, agent, config) {
  const getTool = typeof ctx.tools?.get === 'function' ? (name) => ctx.tools.get(name, agent) : () => undefined
  if (getTool('skill') !== undefined) return true
  return (config.onDemandLoaderTools ?? []).some((name) => getTool(name) !== undefined)
}

async function routeStep(ctx, config, { agent, messages, signal }, decision) {
  signal.throwIfAborted()
  // 尊重 on-demand 预设：当前 agent 没有任何技能加载/发现通道时（严格 on-demand，
  // 如 anchored-standard 组合），默认不自动注入，避免破坏其"零技能上下文"设计。
  // cot-gw / cot-dyn 等组合存在 skill_load/skill_search 通道，视为可路由，正常注入。
  if (config.respectOnDemandPresets) {
    if (!hasSkillLoader(ctx, agent, config)) {
      if (config.verbose) {
        ctx.logger?.info('[skill-router] 检测到严格 on-demand 预设（无 skill/skill_load 等加载工具），跳过自动注入（respectOnDemandPresets）')
      }
      return decision
    }
  }

  const text = collectUserText(messages)
  if (!text) return decision
  if (config.skipShortMessages && text.length < 4) return decision

  // 全新会话的第一条消息不路由：保住 anchored 系预设（anchored-standard/anchored-wsl）
  // 的首轮 Minimal 锚定（bootstrap 阶段压制注入上下文）。从第二条用户消息起正常路由。
  const events = agent.session?.events
  if (Array.isArray(events)) {
    let hasPriorUserMessage = false
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === 'user/message') {
        hasPriorUserMessage = true
        break
      }
    }
    if (!hasPriorUserMessage) {
      if (config.verbose) ctx.logger?.info('[skill-router] 会话首条消息，跳过自动注入（保住首轮锚定）')
      return decision
    }
  }

  const gestureNames = gestureSkillNames(text)
  if (gestureNames.length > 0 && text.replace(GESTURE_RE, ' ').trim().length < 4) {
    // 纯手势消息：dsh-tool-skill 已负责注入，路由不再重复。
    return decision
  }

  const lookup = { cwd: agent.session.header.cwd, signal, scope: agent }
  const baseline = await ensureBaseline(ctx, config, agent, lookup)
  signal.throwIfAborted()
  const snapshot = await ctx.skills.snapshot(lookup)
  signal.throwIfAborted()
  // 千人千面回退：live 目录不完整时用个人基线里的技能当候选（全文仍走 ctx.skills.get 现取）。
  let skillSnapshot = snapshot
  if (!snapshot.complete && baseline?.skills?.length > 0) {
    skillSnapshot = {
      complete: true,
      skills: baseline.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        invocation: { modelInvocable: skill.modelInvocable !== false },
      })),
    }
    if (config.verbose) {
      ctx.logger?.info('[skill-router] live 技能目录不完整，回退个人基线（%d 技能）', baseline.skills.length)
    }
  }
  if (!skillSnapshot.complete) return decision
  const candidates = skillSnapshot.skills.filter(isModelInvocable)
  if (candidates.length === 0) return decision

  const picks = await pickSkills(ctx, config, text, candidates, signal)
  // 防重复注入：显式排除手势/其他注入源已在本轮注入的技能（decision.messages
  // 中的 skill-invocation）与近期已自动注入的技能（injectedRecent）。
  // 摘要发现块同受约束（全文已在场的技能无需摘要提示），但不回写防重名单——
  // 后续强命中同技能时仍可升级为全文注入。
  const alreadyPresent = new Set(
    decision.messages
      .filter((m) => m.source?.kind === 'skill-invocation' && typeof m.source.name === 'string')
      .map((m) => m.source.name),
  )
  const toInject = picks.names
    .filter((skillName) => !gestureNames.includes(skillName))
    .filter((skillName) => !wasInjectedRecently(agent, skillName))
    .filter((skillName) => !alreadyPresent.has(skillName))
    .slice(0, config.maxSkillsPerMessage)
  if (toInject.length === 0 && picks.form !== 'none') return decision

  // MCP 工具发现（千人千面）：按消息给 mcp__* 工具打分，取弱信号阈值以上的命中。
  let mcpMatches = []
  if (config.hintMcpTools && baseline?.mcpTools?.length > 0) {
    const messageTokens = collectTokens(text, true)
    mcpMatches = baseline.mcpTools
      .map((tool) => ({
        tool,
        score: scoreSkill({ name: tool.name, description: tool.description, whenToUse: '' }, messageTokens, text),
      }))
      .filter((entry) => entry.score >= config.minScore * 0.7)
      .sort((a, b) => b.score - a.score)
      .slice(0, config.maxSkillsPerMessage)
      .map((entry) => entry.tool)
  }

  if (picks.form === 'summary' || (picks.form === 'none' && mcpMatches.length > 0)) {
    // 摘要发现块：弱信号不塞全文（数 KB），给模型一个廉价的"发现"入口。
    // 技能行来自命中技能；MCP 行来自个人基线扫描的 mcp__* 工具（千人千面）。
    const byName = new Map(candidates.map((skill) => [skill.name, skill]))
    const lines = []
    if (picks.form === 'summary') {
      for (const skillName of toInject) {
        const skill = byName.get(skillName)
        if (skill !== undefined) lines.push(`- ${skill.name}: ${(skill.description || '').split('\n')[0]}`)
      }
    }
    for (const tool of mcpMatches) {
      lines.push(`- ${tool.name}: ${(tool.description || '').split('\n')[0]}`)
    }
    if (lines.length === 0) return decision
    if (config.verbose) {
      ctx.logger?.info(
        '[skill-router] 弱信号摘要发现: %s（消息: %s）',
        [...toInject, ...mcpMatches.map((tool) => tool.name)].join(', '),
        text.slice(0, 60),
      )
    }
    const footer = toInject.length > 0
      ? `需要技能全文时用 /${toInject[0]} 手势调用（或 skill_load，若可用）；MCP 工具可直接调用；与任务无关可忽略本提示。`
      : '以上为按本环境实际能力匹配的线索：技能可用 /name 手势或 skill_load 加载全文，MCP 工具可直接调用。'
    const hints = [
      '<skill_hints>',
      '以下能力可能与当前任务相关（按匹配度排序，技能全文尚未注入）：',
      ...lines,
      footer,
      '</skill_hints>',
    ].join('\n')
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: hints }],
          source: { kind: 'plugin', plugin: name },
        }),
      ],
    }
  }

  const injections = []
  for (const skillName of toInject) {
    signal.throwIfAborted()
    const skill = await ctx.skills.get(skillName, lookup)
    signal.throwIfAborted()
    if (skill === undefined || !isModelInvocable(skill)) continue
    injections.push(
      createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source: { kind: 'skill-invocation', name: skill.name, form: 'instructions' },
      }),
    )
    markInjected(agent, skill.name)
  }
  if (injections.length === 0) return decision
  if (config.verbose) {
    ctx.logger?.info(
      '[skill-router] 自动加载技能: %s（消息: %s）',
      injections.map((message) => message.source.name).join(', '),
      text.slice(0, 60),
    )
  }
  return { kind: 'enter', messages: [...decision.messages, ...injections] }
}

export default { name, inject, Config, apply }
