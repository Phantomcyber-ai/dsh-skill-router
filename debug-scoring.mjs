// 聚焦调试：两个失败案例的 token 与分值明细
import fs from 'node:fs'

const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export const name.*$/m, 'const __name = null;')
  .replace(/export default .*/s, '')
  .replace(/^export /gm, '')
  .replace('const Config = z.object({', 'const z = { object: (o) => o, string: () => ({ default: () => ({}) }), boolean: () => ({ default: () => ({}) }), number: () => ({ default: () => ({}) }) };\nconst Config = z.object({')
  + '\nexport { collectTokens, scoreSkill, heuristicPick }\n'

const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
const { collectTokens, scoreSkill, heuristicPick } = mod

const SKILLS = [
  { name: 'official-document-writing', description: '起草/修改/审查/排版中文党政公文（通知、报告、请示、纪要、总结、讲话等），支持按 GB/T 9704-2012 排为正式 Word/红头文件。', whenToUse: '写公文、起草通知/报告/请示、公文排版、红头文件、转成 Word 时使用' },
  { name: 'daily-work-assistant', description: '每日工作梳理与可替代任务自我迭代。把零散口述整理成结构化日志、自动识别可替代任务、沉淀模板。', whenToUse: '用户口述当天工作、要求整理或汇总工作、触发每日工作梳理提醒时使用' },
  { name: 'report-drafting', description: '向上级报送的总结报告、专项报告起草（读通知→收材料→数据核验→范文对标→多源融合→初稿→用户审核）。', whenToUse: '起草或修改总结报告、专项报告、学习教育总结、专题报告等向上级报送的材料时使用' },
]

const CASES = ['帮我写一份公文', '帮我整理一下今天的工作']

for (const msg of CASES) {
  const tokens = [...collectTokens(msg, true)]
  console.log(`\n=== ${msg}`)
  console.log('  msgTokens:', tokens.join(' | '))
  for (const s of SKILLS) {
    const score = scoreSkill(s, new Set(tokens), msg)
    console.log(`  ${s.name}: ${score.toFixed(3)}`)
  }
  const picks = heuristicPick(msg, SKILLS, { minScore: 0.5 })
  console.log('  top:', picks.slice(0, 3).map((p) => `${p.skill.name}=${p.score.toFixed(3)}`).join(' '))
}
