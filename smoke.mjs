// 冒烟测试：用 DSH 真实依赖（schemastery / dsh-llm / dsh-skill）真实加载改造后的 index.js，
// 并执行关键路径（cot 自动识别 + 注入、anchored 让位、normalizeConfig 防御、apply 注册）。
// 依赖经 junction node_modules → DSH runtime 解析，非剥壳 mock。
import fs from 'node:fs'

// 尝试导入应用的真实 index.js 若最顶层 schemastery Config 构建非法，
// 会在 import 阶段抛错 —— 这本身就是强信号。
let plugin
try {
  plugin = await import('./index.js').then((m) => m.default)
} catch (error) {
  console.error('[SMOKE-FATAL] index.js 真实加载失败:', error.message)
  process.exit(1)
}

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? 'SMOKE-PASS' : 'SMOKE-FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

// ---- 0. 真实导入成功即证明 import 解析 + schemastery Config（z.array().min()) 链式合法 ----
check('index.js 真实加载成功（import 解析 + Config 构建）', true)

// ---- 1. 插件导出完整性 ----
check('plugin.name = dsh-skill-router', plugin.name === 'dsh-skill-router')
check('plugin.inject 含 skills/tools', Array.isArray(plugin.inject) && plugin.inject.includes('skills') && plugin.inject.includes('tools'))
// schemastery 3 的 z.object() 返回可调用 schema 函数（typeof 'function'），本身即校验器
check('plugin.Config 是 schemastery schema（可调用函数）', typeof plugin.Config === 'function')
check('plugin.apply 已导出', typeof plugin.apply === 'function')

// ---- 2. 真实 schemastery 校验 Config（schema 兼作校验器，直接调用；min(1) 生效）----
{
  const def = plugin.Config(undefined)
  check('Config(undefined) 默认名单生效', JSON.stringify(def.onDemandLoaderTools) === '["skill_load","skill_search"]', JSON.stringify(def.onDemandLoaderTools))
  for (const [label, bad] of [['Config([]) min(1) 应抛', []], ['Config(非数组) 应抛', 'x'], ['Config(含非字符串) 应抛', ['ok', 42]]]) {
    let threw = false
    try { plugin.Config({ onDemandLoaderTools: bad }) } catch { threw = true }
    check(label, threw, threw ? '' : '未抛错')
  }
}

// ---- 3. apply 冒烟：最小 ctx 注册 agent/pre-step 监听不抛 ----
{
  const registered = []
  try {
    plugin.apply({
      get: () => undefined,
      tools: { get: () => undefined },
      skills: { snapshot: async () => ({ complete: true, skills: [] }), get: async () => undefined },
      logger: { info() {}, warn() {} },
      on: (ev) => registered.push(ev),
    }, {})
    check('apply() 注册 agent/pre-step 监听', registered.includes('agent/pre-step'))
  } catch (e) { check('apply() 注册', false, String(e.message ?? e)) }
}

// ---- 4. 导出真实 routeStep/hasSkillLoader/normalizeConfig（追加具名导出到源码副本）----
const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const copyPath = new URL('./.smoke_src.mjs', import.meta.url)
fs.writeFileSync(copyPath, src + '\n\nexport { routeStep, hasSkillLoader, normalizeConfig };\n')
let extra
try {
  extra = await import('./.smoke_src.mjs?smoke=true')
} catch (error) {
  console.error('[SMOKE-FATAL] 源码副本动态导入失败:', error.message)
  process.exit(1)
}
const { routeStep, hasSkillLoader, normalizeConfig } = extra

const SKILLS = [
  { name: 'official-document-writing', provider: 'smoke', description: '起草/修改/审查/排版中文党政公文。', whenToUse: '写公文、起草通知/报告/请示、公文排版时使用', content: '# 技能全文 body', invocation: { modelInvocable: true } },
  { name: 'markitdown-skill', provider: 'smoke', description: '把文件/URL 转成 Markdown（PDF、Word、PPT、Excel、图片 OCR、音频转写、网页）。', whenToUse: '把 PDF/图片/音频转成 Markdown、提取文档文本、批量转格式时使用', content: '# m', invocation: { modelInvocable: true } },
]
const signal = { throwIfAborted() {} }

function makeCtx(mode) {
  return {
    get: () => undefined, // 无 LLM → 启发式路径
    logger: { info() {}, warn() {} },
    tools: {
      get(name) {
        if (mode === 'standard') return name === 'skill' ? {} : undefined
        if (mode === 'cot') return name === 'skill_load' ? {} : undefined
        return undefined // anchored
      },
    },
    skills: {
      snapshot: async () => ({ complete: true, skills: SKILLS }),
      get: async (name) => SKILLS.find((s) => s.name === name),
    },
  }
}
async function route(mode, text) {
  // 每个用例用独立 agent（injectedRecent 按 agent 隔离防重）
  const freshAgent = { session: { header: { cwd: '/tmp' }, events: [{ type: 'user/message' }] } }
  const decision = { kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }] }
  return routeStep(makeCtx(mode), normalizeConfig({ maxSkillsPerMessage: 1 }), { agent: freshAgent, messages: decision.messages, signal }, decision)
}
const injected = (r) => (r.messages ?? []).filter((m) => m.source?.kind === 'skill-invocation').map((m) => m.source.name)

// ---- 5. 真实 end-to-end 路由（真实 createUserMessage + renderSkillContent + isModelInvocable）----
{
  const r = await route('cot', '帮我写一份公文')
  const inj = injected(r)
  check('cot 组合：公文自动注入（真实依赖管线）', JSON.stringify(inj) === '["official-document-writing"]', JSON.stringify(inj))
  const m = r.messages[r.messages.length - 1]
  const body = m?.content?.[0]?.text ?? ''
  check('注入消息 shape：user + skill-invocation + <skill_content>', m?.role === 'user' && m.source?.kind === 'skill-invocation' && body.includes('<skill_content'),
    `first=...${JSON.stringify(body.slice(0, 40))}`)
}
{
  const r = await route('standard', '帮我写一份公文')
  check('standard 组合：正常注入（真实管线回归）', JSON.stringify(injected(r)) === '["official-document-writing"]', JSON.stringify(injected(r)))
}
{
  const r = await route('anchored', '帮我写一份公文')
  check('anchored 组合：让位不注入', injected(r).length === 0, JSON.stringify(injected(r)))
}
{
  const r = await route('cot', '把这份 PDF 转成 Markdown')
  check('cot 组合：PDF → markitdown-skill（真实管线）', JSON.stringify(injected(r)) === '["markitdown-skill"]', JSON.stringify(injected(r)))
}
// 防重（审查修复）：messages 已含技能注入时不再重复
{
  const decision = {
    kind: 'enter',
    messages: [
      { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我写一份公文' }] },
      { source: { kind: 'skill-invocation', name: 'official-document-writing', form: 'instructions' }, content: [{ type: 'text', text: '<skill_content>' }] },
    ],
  }
  const freshAgent = { session: { header: { cwd: '/tmp' }, events: [{ type: 'user/message' }] } }
  const r = await routeStep(makeCtx('cot'), normalizeConfig({ maxSkillsPerMessage: 1 }), { agent: freshAgent, messages: decision.messages, signal }, decision)
  check('手势注入后不重复注入（防重回归）', r.messages.length === decision.messages.length, `消息数 ${r.messages.length} vs ${decision.messages.length}`)
}

// ---- 6. hasSkillLoader / normalizeConfig 语义 ----
check('hasSkillLoader cot=true', hasSkillLoader(makeCtx('cot'), { session: { header: {} } }, normalizeConfig({})) === true)
check('hasSkillLoader anchored=false', hasSkillLoader(makeCtx('anchored'), { session: { header: {} } }, normalizeConfig({})) === false)
check('normalizeConfig 非法名单回退默认', normalizeConfig({ onDemandLoaderTools: 'x' }).onDemandLoaderTools.join(',') === 'skill_load,skill_search')

// 清理临时副本
try { fs.rmSync(copyPath, { force: true }) } catch {}

console.log(failures === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)