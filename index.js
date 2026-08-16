/**
 * dsh-skill-router — 意图级技能自动路由插件。
 *
 * 问题：DSH 的 `<available_skills>` 目录只依赖模型自主判断去调用 `skill` 工具，
 * 技能一多模型注意力就会漏，"该用技能的时候不用"。
 *
 * 方案：在 `agent/pre-step` 钩子里对最新用户消息做路由——
 * 1. 启发式快速打分（中文 bigram + 拉丁 token 重叠 + 技能名/触发短语命中）；
 * 2. 强命中直接注入；弱信号交给 LLM 判定（hybrid 模式）；LLM 不可用/失败回退启发式；
 * 3. 命中即把技能全文以 `skill-invocation` 源注入上下文（与 `/技能名` 手势同一机制，
 *    复用 dsh-tool-skill 的注入管线），模型无需再调用 skill 工具。
 *
 * 任何异常都不会阻断 agent 循环（路由失败只意味着退回现状）。
 */
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'

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
   * 尊重 on-demand 预设（如 anchored-standard）：该组合故意移除技能目录注入，
   * 改由模型用 skill_search/skill_load 按需发现。检测到当前 agent 没有 `skill`
   * 加载工具时，默认不自动注入，避免破坏其"零技能上下文"设计；置 false 强制注入。
   */
  respectOnDemandPresets: z.boolean().default(true),
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
async function llmPick(ctx, config, text, candidates) {
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
  const signal = AbortSignal.timeout(config.llmTimeoutMs)
  let output = ''
  try {
    for await (const chunk of llm.stream({
      ...route,
      messages,
      temperature: 0,
      maxTokens: 120,
      signal,
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

/** 对一条用户消息执行完整路由：返回要注入的技能名列表。 */
async function pickSkills(ctx, config, text, candidates) {
  const scored = heuristicPick(text, candidates, config)
  const best = scored[0]
  const topNames = (count) => scored.slice(0, count).map((entry) => entry.skill.name)

  if (config.mode === 'heuristic') return topNames(config.maxSkillsPerMessage)

  if (best && best.score >= config.minScore) {
    // 强命中：与第一名差距很小的并列技能一起注入，但不超过上限。
    return scored
      .filter((entry) => entry.score >= best.score - 0.15)
      .slice(0, config.maxSkillsPerMessage)
      .map((entry) => entry.skill.name)
  }

  if (config.mode === 'llm' || (config.mode === 'hybrid' && scored.length > 0)) {
    const fromLlm = await llmPick(ctx, config, text, candidates)
    if (fromLlm !== undefined && fromLlm.length > 0) return fromLlm
    // LLM 无匹配或调用失败：回退到启发式第一名（需有不弱于 0.7×阈值 的弱信号，防误注入）。
    if (best && best.score >= config.minScore * 0.7) return [best.skill.name]
  }
  return []
}

function apply(ctx, config = {}) {
  const resolved = { ...DEFAULT_CONFIG, ...config }

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

async function routeStep(ctx, config, { agent, messages, signal }, decision) {
  signal.throwIfAborted()
  // 尊重 on-demand 预设：当前 agent 没有 `skill` 加载工具（dsh-tool-skill 未挂载，
  // 如 anchored-standard 组合）时，默认不自动注入，避免破坏其"零技能上下文"设计。
  if (config.respectOnDemandPresets) {
    const loaderTool = typeof ctx.tools?.get === 'function' ? ctx.tools.get('skill', agent) : undefined
    if (loaderTool === undefined) {
      if (config.verbose) {
        ctx.logger?.info('[skill-router] 检测到 on-demand 预设（无 skill 加载工具），跳过自动注入（respectOnDemandPresets）')
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
  const snapshot = await ctx.skills.snapshot(lookup)
  signal.throwIfAborted()
  if (!snapshot.complete) return decision
  const candidates = snapshot.skills.filter(isModelInvocable)
  if (candidates.length === 0) return decision

  const picks = await pickSkills(ctx, config, text, candidates)
  const toInject = picks
    .filter((skillName) => !gestureNames.includes(skillName))
    .filter((skillName) => !wasInjectedRecently(agent, skillName))
    .slice(0, config.maxSkillsPerMessage)
  if (toInject.length === 0) return decision

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
