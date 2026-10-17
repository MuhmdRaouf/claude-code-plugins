# claude-code-plugins

Claude Code plugins that hand bulk work to other models while Claude keeps the planning and the review.

| Plugin | Provider | Setup |
|---|---|---|
| `zai-plugin-cc` | GLM (Z.ai) | `/zai:setup` |
| `kimi-plugin-cc` | Kimi (Moonshot AI) | `/kimi:setup` |
| `deepseek-plugin-cc` | DeepSeek | `/deepseek:setup` |
| `minimax-plugin-cc` | MiniMax | `/minimax:setup` |
| `qwen-plugin-cc` | Qwen (Alibaba Cloud) | `/qwen:setup` |

Each plugin adds two agents (a main model and a flash model), routes their requests through a local router, and
runs verified background jobs in isolated git worktrees. Claude reviews every job before it lands.

Every plugin installs [huddle](https://github.com/MuhmdRaouf/huddle) with it: the session hub, the radar dashboard
of requests, tokens and cost, and the kanban board.

## Install

In Claude Code:

```text
/plugin marketplace add MuhmdRaouf/claude-code-plugins
/plugin install zai-plugin-cc@muhmdraouf
```

Remote Control (`claude rc`) keeps working: the router is reached as an HTTPS proxy, so `ANTHROPIC_BASE_URL` stays
unset.

## Platforms

macOS and Linux, on amd64 and arm64.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
