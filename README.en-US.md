# dsh-skill-router

**Intent-level skill auto-routing for DeepSeek Harness — the harness finally uses skills when it should.**

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> The problem: DSH injects an `<available_skills>` catalog into the context, but whether a skill gets
> loaded depends entirely on the model's own judgment. With many skills, the model misses the right one.
> `dsh-skill-router` hooks `agent/pre-step` and routes every user message: on a hit, the full skill body
> is injected into the context automatically — the model never has to remember to call the `skill` tool.

## How it works

```
user message → heuristic scoring (zero LLM cost)
                ├─ strong hit (≥ minScore) → inject skill body directly
                └─ weak signal → LLM judgment (12s timeout, falls back to the weak band)
                        ├─ judged hit → inject skill body (createUserMessage + skill-invocation source)
                        └─ fallback per weakForm ─ summary: compact hints block (default)
                                                ├ full: body fallback (v0.2 behavior)
                                                └ none: skip
```

- Chinese-aware heuristic: CJK bigram segmentation (stopword filtering), latin token overlap, skill-name and `whenToUse` trigger-phrase hits.
- Three-tier routing: strong hits inject the full body; weak signals go to LLM judgment; the unresolved weak band falls back to a compact **skill-hints summary block** by default (`weakForm: summary`) — borrowing the discovery/loading separation of [dsh_cot_gw_dyn](https://github.com/CZM1998/dsh_cot_gw_dyn)'s `skill_search` (large-body injections perturb trajectories; summaries are cheap to discover from), while staying zero-tool-registration.
- **Per-user personalization (v0.4)**: on first route the plugin scans this environment's actual skill catalog and MCP tool surface (`ctx.tools.schemas` enumerating `mcp__<server>__<tool>`) into a persisted baseline (refreshed periodically). The weak-signal hints block additionally lists message-matched MCP tools — every user discovers what *their* environment really has — and an incomplete live catalog falls back to baseline candidates.
- Reuses the official injection pipeline (`skill-invocation` source) — the same mechanism as the `/skill-name` gesture.
- Never breaks the agent loop: any routing failure just falls back to the status quo.
- No tools registered, no tool-catalog pollution.
- Compatible with experimental presets: on strict on-demand compositions with NO skill channel at all (`anchored-standard`-style, no `skill` and no `skill_load`/`skill_search`) auto-routing steps aside by default; **cot-family presets (cot-gw / cot-dyn) that expose `skill_load`/`skill_search` are auto-detected (`onDemandLoaderTools`) and routed normally** — automatic injection coexists with on-demand discovery. The very first message of a fresh session is never injected (preserves the first-request Minimal anchor).

## Install

Runtime injection via dsh-super-injector:

```bash
dev_inject_plugin <this repo dir>
```

Or add it to the profile `bundles` for persistent assembly.

## Config

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `mode` | `hybrid` | `hybrid` / `heuristic` (zero LLM) / `llm` (always judge) |
| `llmProvider` / `llmModel` | empty | Judge model route; empty = auto-pick first available provider |
| `maxSkillsPerMessage` | `2` | Max skills injected per message |
| `minScore` | `0.5` | Heuristic strong-hit threshold |
| `weakForm` | `summary` | Fallback form for the weak band (no judged hit): `summary` injects a compact hints block (skill name + one-line description + `/name` gesture hint; `plugin` source, does not occupy the full-text dedup set, a later strong hit can still upgrade to full text); `full` falls back to the full body (v0.2 behavior); `none` injects nothing |
| `personalBaseline` | `true` | On first route, scan this environment's actual skill catalog + MCP tool surface and persist a per-workspace baseline, refreshed periodically (per-user personalization) |
| `hintMcpTools` | `true` | Include message-matched MCP tools (`mcp__<server>__<tool>`, from the baseline scan) in the weak-signal hints block |
| `baselineRefreshHours` | `24` | Baseline refresh interval; the next routed step rescans when expired (delete the file to force a rescan) |
| `baselineDir` | empty | Baseline directory; empty = `<DSH_HOME|~/.dsh>/plugins/dsh-skill-router/` (one file per cwd hash) |
| `llmTimeoutMs` | `12000` | LLM judgment timeout |
| `skipShortMessages` | `true` | Skip "continue"/"ok" style messages |
| `respectOnDemandPresets` | `true` | Yield only when the composition has NO skill channel at all (`anchored-standard`-style); routed normally when `skill` OR any `onDemandLoaderTools` tool exists (standard / cot-gw / cot-dyn) |
| `onDemandLoaderTools` | `['skill_load', 'skill_search']` | Tool names treated as an on-demand skill channel (cot-family presets) |
| `verbose` | `true` | Log injections |

## Test

```bash
node test-router.mjs    # functional test: standard / anchored scenarios
node test-integration.mjs  # upgrade verification: cot-family auto-detection + routing (12 assertions)
node debug-scoring.mjs  # scoring debug
```

Dependencies: `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-skill`, `@deepseek-ai/schemastery`.

## License

MIT
