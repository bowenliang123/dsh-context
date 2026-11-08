# Model pricing mapping

Cost is estimated from [models.dev](https://models.dev) list prices. It is a reference, not a provider invoice. The plugin host fetches and caches the catalogue (1 h TTL) and resolves every billed `(provider, model)` pair itself; the browser receives the resolved rate face and the priced total, never the full price list. The resolver picks a listing in this order:

```text
(provider, model)
├─ known provider branch
│  ├─ exact / suffix / branch dialect / normalized match → that branch's rate
│  ├─ no match, single-vendor branch → unpriced: the provider does not list it
│  └─ no match, multi-vendor branch → keep looking
├─ model's org segment is a provider branch → that branch's rate
├─ canonical labs
│  ├─ one lab → maker's rate if listed
│  ├─ several labs → org/family hint → maker's rate, else unpriced: ambiguous
│  └─ no lab → family vendor's rate if listed
└─ one carrier, or all carriers agree → reference rate
   otherwise → unpriced
```

A known provider branch keeps its own rate. A single-vendor branch never borrows another vendor's price; a multi-vendor branch (Azure, Vertex, Cloudflare AI Gateway, OpenRouter, Vercel, OpenCode) may fall through to the maker. The “maker” is the lab named by models.dev's `canonical_model_id`, e.g. `anthropic` in `anthropic/claude-sonnet-5-5`.

Coding/token plan branches are subscription entitlements; models.dev lists them at **0 per-token** cost. They are excluded from per-token pricing, so their routes fall through to the maker's list price as a reference.

## Examples

The right side is the exact registry face shown in the tooltip.

| Input `(provider, model)` | Final mapping | Rule |
| --- | --- | --- |
| `azure` / `gpt-5.6-sol` | `azure` / `gpt-5.6-sol` | direct |
| `codex` / `gpt-5.6-sol` | `openai` / `gpt-5.6-sol` | provider alias |
| `CLIProxyAPI` / `claude-sonnet-5-5` | `anthropic` / `claude-sonnet-5-5` | canonical maker |
| `magpie` / `google-vertex/gemini-4-argon` | `google-vertex` / `gemini-4-argon` | org branch |
| `cloudflare-ai-gateway` / `claude-fable-5` | `cloudflare-ai-gateway` / `anthropic/claude-fable-5` | branch dialect |
| `chanyan` / `kimi-k3` | `moonshotai` / `kimi-k3` | canonical maker |
| `chanyan` / `glm-5.3` | `zhipuai` / `glm-5.3` | canonical maker |
| `chanyan` / `deepseek-flash` | `deepseek` / `deepseek-flash` | canonical maker |
| `opencode` / `claude-sonnet-5` | `opencode` / `claude-sonnet-5` | direct (Zen listing) |
| `opencode-go` / `glm-5.3` | `opencode-go` / `glm-5.3` | direct (Zen Go listing) |
| `anthropic` / `claude-sonnet-4.5` | `anthropic` / `claude-sonnet-4-5-20250929` | normalized spelling |
| `openrouter` / `anthropic/claude-sonnet-4.5` | `openrouter` / `anthropic/claude-sonnet-4.5` | direct (model keeps its slash) |
| `unknown` / `acme-private-model-2099` | — | not in the book |

Short aliases such as `k3` are resolved only inside a known provider branch (`kimi-coding` + `k3`). An unknown route needs the full model ID; global suffix guessing is deliberately disabled because it can match an unrelated model.

OpenCode Zen (`opencode`) and OpenCode Go (`opencode-go`) are ordinary known branches: IDs present in each branch use its own listed rate. Models the branch does not list fall through to the maker or stay unpriced; a multi-vendor gateway is not assumed to serve everything. In DSH these are the pi-ai route IDs `opencode` and `opencode-go`; their model IDs are the bare Zen IDs (`claude-sonnet-5`, `glm-5.3`).

## Coding plans

Models.dev lists coding/token plans at $0 per token because they are subscription entitlements, not free API rates. Those branches are skipped; these routes resolve to the maker as a reference:

| Route / model | Final mapping | Why |
| --- | --- | --- |
| `kimi-coding` / `k3` | `moonshotai` / `kimi-k3` | maker reference; `kimi-code-plan-*` is a plan |
| `zai-coding-cn` / `glm-5.3` | `zhipuai` / `glm-5.3` | maker reference; `zai-coding-plan` is a plan |
| `qwen-token-plan` / `qwen3.8-max` | `alibaba` / `qwen3.8-max` | per-model maker |
| `qwen-token-plan` / `deepseek-v4-pro` | `deepseek` / `deepseek-v4-pro` | per-model maker |
| `xiaomi-token-plan-cn` / `mimo-v2.5` | `xiaomi` / `mimo-v2.5` | maker reference |
| `minimax-cn` / `minimax-m2.5` | `minimax-cn` / `MiniMax-M2.5` | direct regional branch |
| `kimi-code-plan-global` / `k3` | `moonshotai` / `kimi-k3` | plan branch excluded; maker alias |
| `zai-coding-plan` / `glm-5.3` | `zai` / `glm-5.3` | plan branch excluded; maker alias |
| `zhipuai-coding-plan` / `glm-5.3` | `zhipuai` / `glm-5.3` | plan branch excluded; maker alias |
| `alibaba-token-plan` / `qwen3.8-max` | `alibaba` / `qwen3.8-max` | per-model maker |

This is why a coding-plan session shows a maker reference price, not `$0`. The $0 is the plan's marginal token price, not the public API price. A plan-only model the maker does not list (for example `k3-256k` or `glm-5.3-highspeed`) stays unpriced rather than borrowing a different model's rate.

## Reading the tooltip

- **Reference estimate** — the provider may not list this exact model; the maker's list price is used.
- **Not priced: … is not in the models.dev price book** — no branch carries the model.
- **Not priced: … has N entries with different rates** — carriers disagree and no authority selects one.
- **Model prices are unavailable (retrying automatically)** — the price book failed to load; this is not a mapping gap.

## Boundaries

- models.dev lists public USD prices; private contracts, regional pricing, reseller discounts, and CNY-only lists are not represented.
- Billing suffixes such as `:free` and `:batch` are not stripped; if models.dev does not list that variant, it stays unpriced.
- Subscription routes may not bill per token.
- DeepSeek's listed rate is off-peak; peak windows bill at 2×. Other providers are flat-rate.
- Context-tier pricing and tool-side model calls are out of scope.

If a mainstream model is unpriced, report the exact provider ID, model ID, expected models.dev entry, and tooltip reason. User-maintained per-model price tables are not supported.
