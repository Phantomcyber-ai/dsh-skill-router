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
                └─ weak signal → LLM judgment (12s timeout, falls back to heuristic top-1)
                        → inject via createUserMessage + skill-invocation source
```

- Chinese-aware heuristic: CJK bigram segmentation (stopword filtering), latin token overlap, skill-name and `whenToUse` trigger-phrase hits.
- Reuses the official injection pipeline (`skill-invocation` source) — the same mechanism as the `/skill-name` gesture.
- Never breaks the agent loop: any routing failure just falls back to the status quo.
- No tools registered, no tool-catalog pollution.
- Compatible with experimental presets: on `anchored-standard`-style compositions (no `skill` loader tool) auto-routing steps aside by default; the very first message of a fresh session is never injected (preserves the first-request Minimal anchor).

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
| `llmTimeoutMs` | `12000` | LLM judgment timeout |
| `skipShortMessages` | `true` | Skip "continue"/"ok" style messages |
| `respectOnDemandPresets` | `true` | Yield to anchored-standard-style compositions (no `skill` tool) |

## Test

```bash
node test-router.mjs    # functional test: simulated agent/pre-step with a real skill catalog
node debug-scoring.mjs  # scoring debug
```

Dependencies: `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-skill`, `@deepseek-ai/schemastery`.

## License

MIT
