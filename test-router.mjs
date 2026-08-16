// 功能测试：用本会话真实技能目录模拟 agent/pre-step，验证 dsh-skill-router 的路由与注入。
import plugin from './index.js'

// 来自本会话 <available_skills> 的真实目录（name + description + whenToUse）
const CATALOG = [
  { name: 'agent-browser', description: 'Browser automation CLI for AI agents. 浏览器自动化：导航、填表、点击、截图、抓取数据、测试 Web 应用。', whenToUse: '用户要求打开网站、填表单、点按钮、截图、抓取网页数据、测试 Web 应用或自动化浏览器操作时使用' },
  { name: 'bili-transcribe', description: 'B站视频语音听译/转写技能 - 将 B 站视频音频下载并转写为中文文本。', whenToUse: '用户给出 B 站视频链接（含 BV 号）要求听译、转写、提取字幕、语音识别全文时使用' },
  { name: 'browser-use', description: 'Automates browser interactions for web testing, form filling, screenshots, and data extraction.', whenToUse: '' },
  { name: 'study-record-filler', description: '补全分行党委中心组学习记录的研讨发言（多位行领导，重点发言人必含某位，未指定时先询问）。', whenToUse: '补全或生成中心组学习记录、补研讨发言、写中心组学习研讨时使用' },
  { name: 'cordis-plugin-development', description: 'Create, modify, debug, or extend dynamic Cordis Plugins, including Host Services and Events, Client Slot and theme UI.', whenToUse: '创建、修改、调试或扩展动态 Cordis 插件时使用' },
  { name: 'daily-work-assistant', description: '每日工作梳理与可替代任务自我迭代。把零散口述整理成结构化日志、识别可替代任务、沉淀模板。', whenToUse: '用户口述当天工作、要求整理或汇总工作、触发每日工作梳理提醒时使用' },
  { name: 'deep-research', description: '结构化深度调研：/research 出大纲、/research-deep 并行深挖、/research-report 汇总报告。', whenToUse: '深度调研、研究某个主题、技术选型调研、市场分析、尽职调查时使用' },
  { name: 'dsh-maintenance', description: '一键诊断/维护/重装 DeepSeek Harness (dsh) 桌面封装应用。', whenToUse: '用户说 dsh 打不开/维护 dsh/重装 dsh/更新 dsh/dsh 诊断时使用' },
  { name: 'editing-cordis-compositions', description: '创建、更改或验证本 harness 的 Cordis composition（agent preset、插件行）。', whenToUse: '编写或修改 agent preset、增删插件行、诊断预设挂载时使用' },
  { name: 'find-skills', description: '场景驱动+关键词双模式技能发现工具。从官方内置、本地已安装、SkillHub、GitHub 等六层联合搜索并推荐技能。', whenToUse: '用户用自然语言描述场景或明确说安装技能/find skills/找个 skill 时使用' },
  { name: 'github', description: 'Interact with GitHub using the gh CLI. Use gh issue, gh pr, gh run, and gh api.', whenToUse: '涉及 GitHub issue/PR/CI/API 查询时使用' },
  { name: 'grill-me', description: 'Interview the user relentlessly about a plan or design until reaching shared understanding.', whenToUse: '用户想压力测试一个方案或设计、提到 grill me 时使用' },
  { name: 'markitdown-skill', description: '把文件/URL 转成 Markdown（PDF、Word、PPT、Excel、图片 OCR、音频转写、网页）。', whenToUse: '把 PDF/图片/音频转成 Markdown、提取文档文本、批量转格式时使用' },
  { name: 'official-document-writing', description: '起草/修改/审查/排版中文党政公文（通知、报告、请示、纪要、总结、讲话等），支持按 GB/T 9704-2012 排为正式 Word/红头文件。', whenToUse: '写公文、起草通知/报告/请示、公文排版、红头文件、转成 Word 时使用' },
  { name: 'report-drafting', description: '向上级报送的总结报告、专项报告起草（读通知→收材料→数据核验→范文对标→初稿）。', whenToUse: '起草或修改总结报告、专项报告、学习教育总结、专题报告等向上级报送的材料时使用' },
  { name: 'self-improvement', description: 'Captures learnings, errors, and corrections to enable continuous improvement.', whenToUse: '命令或操作意外失败、用户纠正、请求了不存在的功能、发现更好的做法时使用' },
  { name: 'zhihu', description: '使用知乎开放平台搜索知乎和全网内容、获取热榜、调用知乎直答，或读取当前用户自己的知乎创作。', whenToUse: '用户提到知乎搜索、社区观点、热榜、知乎直答或要求查看知乎内容时使用' },
]

function makeSkills() {
  return CATALOG.map((s) => ({ ...s, provider: 'test', source: 'runtime', invocation: { modelInvocable: true, userInvocable: true } }))
}

async function run(message, { onDemand = false, firstMessage = false } = {}) {
  const listeners = []
  const ctx = {
    on(event, fn) { if (event === 'agent/pre-step') listeners.push(fn) },
    get(name) { return undefined }, // 无 LLM：验证启发式路径
    tools: {
      // standard 组合有 `skill` 加载工具；on-demand 组合（anchored-standard）没有
      get(toolName) { return onDemand ? undefined : (toolName === 'skill' ? { name: 'skill' } : undefined) },
    },
    skills: {
      async snapshot() { return { complete: true, skills: makeSkills() } },
      async get(skillName) {
        const s = CATALOG.find((x) => x.name === skillName)
        return s ? { ...s, provider: 'test', source: 'runtime', invocation: { modelInvocable: true, userInvocable: true }, content: `# ${s.name}\n（技能全文）\n${s.description}` } : undefined
      },
    },
    logger: { info() {}, warn() {} },
  }
  plugin.apply(ctx, {})
  const batch = [{ source: { kind: 'user' }, content: [{ type: 'text', text: message }] }]
  const agent = {
    session: {
      header: { cwd: 'D:\\DSH\\工作区域' },
      events: firstMessage ? [] : [{ type: 'user/message' }],
    },
  }
  const decision = await listeners[0](
    { agent, messages: batch, signal: AbortSignal.timeout(8000) },
    async () => ({ kind: 'enter', messages: [...batch] }),
  )
  const injected = (decision.messages || [])
    .filter((m) => m.source && m.source.kind === 'skill-invocation')
    .map((m) => `${m.source.name}${m.content[0].text.startsWith('<skill_content') ? '' : ' [无正文!]'}`)
  return injected.length > 0 ? injected.join(', ') : '(未注入)'
}

const cases = [
  '帮我写一份公文',
  '给分行党委中心组补全学习记录',
  '把这份 PDF 转成 Markdown',
  '帮我整理一下今天的工作',
  '深度调研一下国产大模型市场',
  'dsh 打不开了，帮我诊断',
  '在知乎上搜一下这个话题',
  '继续',
  '嗯',
  '帮我找个能画海报的技能',
  '写一份向上级报送的专项报告',
  '帮我截个网页图看看',
]

for (const c of cases) {
  const result = await run(c)
  console.log(`[${c}] → ${result}`)
}

console.log('\n--- on-demand 预设场景（anchored-standard 组合，无 skill 工具） ---')
for (const c of ['帮我写一份公文', '给分行党委中心组补全学习记录']) {
  const result = await run(c, { onDemand: true })
  console.log(`[${c}] → ${result}`)
}

console.log('\n--- 全新会话首条消息（保住首轮锚定） ---')
console.log(`[帮我写一份公文] → ${await run('帮我写一份公文', { firstMessage: true })}`)
