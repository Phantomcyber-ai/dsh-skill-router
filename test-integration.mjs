// 集成测试：验证 dsh-skill-router 改造后对 cot 系预设（有 skill_load 无 skill）的自动兼容。
// 用 debug-scoring.mjs 的"剥壳"技巧：剥掉外部 import，注入 mock 依赖，然后直接测
// hasSkillLoader 与 routeStep 的完整路由行为（三种组合：standard / cot / anchored）。
import fs from 'node:fs'

let src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export const /gm, 'const ')
  .replace(/^export function /gm, 'function ')
  .replace(/^export default .*/s, '')
  // 正则替换（不依赖源码精确文本），注入 mock schemastery 后保留 Config 定义
  .replace(/const Config = z\.object\(\{/, 'const z = { object: (o) => o, string: () => ({ default: () => ({}) }), boolean: () => ({ default: () => ({}) }), number: () => ({ default: () => ({}) }), array: () => ({ min: () => ({ default: () => ({}) }), default: () => ({}) }) };\nconst Config = z.object({')

const mocks = `
const createUserMessage = (msg) => ({ ...msg, role: 'user' })
const isModelInvocable = () => true
const renderSkillContent = (skill) => skill.content
export { hasSkillLoader, routeStep, normalizeConfig, Config }
`
src += mocks

let mod
try {
  mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
} catch (error) {
  console.error('MODULE LOAD FAILED:', error.message)
  process.exit(1)
}
const { hasSkillLoader, routeStep, normalizeConfig, Config } = mod

check('Config 导出为对象（schemastery schema）', typeof Config === 'object' && Config !== null)

// 直接构造最终配置（等价于 DEFAULT_CONFIG + 用户覆盖），不依赖 mock z 的展开语义
const config = {
  enabled: true,
  mode: 'hybrid',
  maxSkillsPerMessage: 1,
  minScore: 0.5,
  llmTimeoutMs: 12000,
  skipShortMessages: true,
  respectOnDemandPresets: true,
  onDemandLoaderTools: ['skill_load', 'skill_search'],
  verbose: false,
}

// ---- 真实技能目录（与 test-router.mjs 同源） ----
const CATALOG = [
  { name: 'official-document-writing', description: '起草/修改/审查/排版中文党政公文（通知、报告、请示、纪要、总结、讲话等），支持按 GB/T 9704-2012 排为正式 Word/红头文件。', whenToUse: '写公文、起草通知/报告/请示、公文排版、红头文件、转成 Word 时使用' },
  { name: 'markitdown-skill', description: '把文件/URL 转成 Markdown（PDF、Word、PPT、Excel、图片 OCR、音频转写、网页）。', whenToUse: '把 PDF/图片/音频转成 Markdown、提取文档文本、批量转格式时使用' },
  { name: 'orchestration', description: 'Understand when and how to use subagents, workflows, and iterative loops.', whenToUse: '' },
]

function makeSkills() {
  return CATALOG.map((s) => ({ ...s, provider: 'test', source: 'runtime', invocation: { modelInvocable: true, userInvocable: true }, content: `# ${s.name}\n（技能全文）` }))
}

let failures = 0
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

// ---- 1. hasSkillLoader 单元测试：三种组合 + 自定义 loader 名单 ----
const agent = { session: { header: { cwd: '/tmp' }, events: [{ type: 'user/message' }] } }
const makeCtx = (tools) => ({ tools })

check('standard 有 skill 工具 → hasSkillLoader=true', hasSkillLoader(makeCtx({ get: (n) => n === 'skill' ? {} : undefined }), agent, config) === true)
check('cot 有 skill_load 无 skill → hasSkillLoader=true（改造后新增行为）', hasSkillLoader(makeCtx({ get: (n) => n === 'skill_load' ? {} : undefined }), agent, config) === true)
check('cot 有 skill_search 无 skill → hasSkillLoader=true', hasSkillLoader(makeCtx({ get: (n) => n === 'skill_search' ? {} : undefined }), agent, config) === true)
check('anchored 两者皆无 → hasSkillLoader=false（仍让位）', hasSkillLoader(makeCtx({ get: () => undefined }), agent, config) === false)
check('ctx.tools 无 get 方法 → hasSkillLoader=false（安全）', hasSkillLoader({ tools: {} }, agent, config) === false)
check('自定义 onDemandLoaderTools（只认 dev_tool_search）→ false', hasSkillLoader(makeCtx({ get: (n) => n === 'skill_load' ? {} : undefined }), agent, { ...config, onDemandLoaderTools: ['dev_tool_search'] }) === false)
check('自定义 onDemandLoaderTools 命中 → true', hasSkillLoader(makeCtx({ get: (n) => n === 'dev_tool_search' ? {} : undefined }), agent, { ...config, onDemandLoaderTools: ['dev_tool_search'] }) === true)

// ---- 1.5 normalizeConfig 防御性规范化（低级待办修复） ----
check('normalizeConfig：合法配置原样通过', normalizeConfig({ onDemandLoaderTools: ['skill_load'] }).onDemandLoaderTools.join(',') === 'skill_load')
check('normalizeConfig：非数组名单回退默认', normalizeConfig({ onDemandLoaderTools: 'skill_load' }).onDemandLoaderTools.join(',') === 'skill_load,skill_search')
check('normalizeConfig：空名单回退默认（min(1) 语义）', normalizeConfig({ onDemandLoaderTools: [] }).onDemandLoaderTools.join(',') === 'skill_load,skill_search')
check('normalizeConfig：含非字符串元素回退默认', normalizeConfig({ onDemandLoaderTools: ['skill_load', 42] }).onDemandLoaderTools.join(',') === 'skill_load,skill_search')
check('normalizeConfig：非法 mode 回退 hybrid', normalizeConfig({ mode: 'random' }).mode === 'hybrid')
check('normalizeConfig：非正 maxSkillsPerMessage 回退 2', normalizeConfig({ maxSkillsPerMessage: 0 }).maxSkillsPerMessage === 2)
check('normalizeConfig：非法 llmTimeoutMs 回退 12000', normalizeConfig({ llmTimeoutMs: -5 }).llmTimeoutMs === 12000)

// ---- 2. routeStep 端到端：三种组合下"帮我写一份公文"的实际注入 ----
function makeFullCtx(mode) {
  return {
    get() { return undefined }, // 无 LLM：走启发式路径
    tools: {
      get(toolName) {
        if (mode === 'standard') return toolName === 'skill' ? { name: 'skill' } : undefined
        if (mode === 'cot') return toolName === 'skill_load' ? { name: 'skill_load' } : undefined
        return undefined // anchored
      },
    },
    skills: {
      async snapshot() { return { complete: true, skills: makeSkills() } },
      async get(skillName) {
        const s = CATALOG.find((x) => x.name === skillName)
        return s ? { ...s, content: `# ${s.name}\n（技能全文）` } : undefined
      },
    },
    logger: { info() {}, warn() {} },
  }
}
const signal = { throwIfAborted() {} }
const makeAgent = () => ({ session: { header: { cwd: '/tmp' }, events: [{ type: 'user/message' }] } })

async function route(mode, message) {
  const decision = { kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: message }] }] }
  // 每个用例用全新 agent（injectedRecent 防重复注入按 agent 隔离，模拟不同会话）
  return routeStep(makeFullCtx(mode), config, {
    agent: makeAgent(),
    messages: decision.messages,
    signal,
  }, decision)
}
const injectedNames = (res) => (res.messages || []).filter((m) => m.source?.kind === 'skill-invocation').map((m) => m.source.name)

{
  const r = await route('standard', '帮我写一份公文')
  check('standard 组合：公文消息自动注入 official-document-writing', JSON.stringify(injectedNames(r)) === '["official-document-writing"]', '→ ' + JSON.stringify(injectedNames(r)))
}
{
  const r = await route('cot', '帮我写一份公文')
  check('cot 组合：公文消息自动注入 official-document-writing（改造后新增行为）', JSON.stringify(injectedNames(r)) === '["official-document-writing"]', '→ ' + JSON.stringify(injectedNames(r)))
}
{
  const r = await route('anchored', '帮我写一份公文')
  check('anchored 组合：不注入（让位）', injectedNames(r).length === 0, '→ ' + JSON.stringify(injectedNames(r)))
}
{
  const r = await route('cot', '把这份 PDF 转成 Markdown')
  check('cot 组合：PDF 消息注入 markitdown-skill', JSON.stringify(injectedNames(r)) === '["markitdown-skill"]', '→ ' + JSON.stringify(injectedNames(r)))
}
{
  // 修复#2 回归：本轮 decision 已含技能注入（如 /手势 已加载）时，路由不得重复注入
  const decision = {
    kind: 'enter',
    messages: [
      { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我写一份公文' }] },
      { source: { kind: 'skill-invocation', name: 'official-document-writing', form: 'instructions' }, content: [{ type: 'text', text: '# 已注入' }] },
    ],
  }
  const r = await routeStep(makeFullCtx('cot'), config, { agent: makeAgent(), messages: decision.messages, signal }, decision)
  // 判断"无新增注入"：router 只在末尾追加，消息数不变即未重复注入
  const unchanged = r.messages.length === decision.messages.length
  check('手势已注入后路由不重复注入（防重扩展）', unchanged,
    `→ 消息数 ${r.messages.length} vs ${decision.messages.length}（含注入: ${JSON.stringify(injectedNames(r))}）`)
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)