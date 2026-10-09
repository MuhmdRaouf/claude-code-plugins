<p align="center">
  <img src="assets/banner.svg" alt="claude-code-plugins: a marketplace of Claude Code plugins" width="100%"/>
</p>

<p align="center">
  <a href="https://github.com/MuhmdRaouf/claude-code-plugins/actions/workflows/ci.yml"><img src="https://github.com/MuhmdRaouf/claude-code-plugins/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg" alt="License: GPL-3.0-or-later"></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude_Code-plugins-cba6f7" alt="Claude Code plugins"></a>
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-1.3+-fbf0df?logo=bun&amp;logoColor=black" alt="Bun 1.3+"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-22.3+-5FA04E?logo=nodedotjs&amp;logoColor=white" alt="Node 22.3+"></a>
</p>

<p align="center">
  <a href="https://github.com/sponsors/MuhmdRaouf"><img src="https://img.shields.io/badge/Sponsor_on_GitHub-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white" height="36" alt="Sponsor on GitHub"></a>&nbsp;&nbsp;<a href="https://buymeacoffee.com/muhmdraouf"><img src="https://img.shields.io/badge/Buy_me_a_coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black" height="36" alt="Buy me a coffee"></a>
</p>

A [Claude Code](https://code.claude.com) plugin marketplace with three jobs:

- **Delegate:** hand bulk work to other models while Claude keeps the planning and the review.
- **Team up:** let several Claude sessions work as one team.
- **Watch:** see what every agent does and spends on a local dashboard.

## Contents

- [Plugins](#plugins)
- [How the plugins fit together](#how-the-plugins-fit-together)
- [Quick start](#quick-start)
- [Update](#update)
- [Uninstall](#uninstall)
- [Requirements](#requirements)
- [Development](#development)

## Plugins

### Delegate to other models

Each provider plugin adds two Claude Code agents: a main model for implementation and bulk edits, and a flash model,
the faster tier for the same work, read-only sweeps included.

| Plugin | Provider | Agents | Setup |
|---|---|---|---|
| [zai-plugin-cc](plugins/zai-plugin-cc) | GLM (Z.ai) | `zai:glm-5.3`, `zai:glm-5.3-flash` | `/zai:setup` |
| [kimi-plugin-cc](plugins/kimi-plugin-cc) | Kimi (Moonshot AI) | `kimi:kimi-k3`, `kimi:kimi-k2.6` | `/kimi:setup` |
| [deepseek-plugin-cc](plugins/deepseek-plugin-cc) | DeepSeek | `deepseek:deepseek-v4-pro`, `deepseek:deepseek-flash` | `/deepseek:setup` |
| [minimax-plugin-cc](plugins/minimax-plugin-cc) | MiniMax | `minimax:MiniMax-M3`, `minimax:MiniMax-M2.7-highspeed` | `/minimax:setup` |

Commands every provider plugin has (`<p>` is `zai`, `kimi`, `deepseek`, `minimax` or `qwen`):

| Command | What it does |
|---|---|
| `/<p>:board` | What runs now |
| `/<p>:usage` | Tokens, estimated cost and router health |
| `/<p>:review [job id]` | Review a finished background job |
| `/<p>:setup:omp`, `:opencode`, `:pi` | Hand jobs to [omp](https://github.com/can1357/oh-my-pi), [opencode](https://opencode.ai) or [pi](https://github.com/badlogic/pi-mono), run as you set them up |
| `/<p>:remove` | Turn the plugin off |

### Team and dashboard

| Plugin | What it does | Setup |
|---|---|---|

Both dashboards are local pages on `127.0.0.1` and follow your system's light or dark mode (Catppuccin Latte and
Mocha).

[plugins.md](plugins.md) covers every plugin in depth.

## How the plugins fit together

- A provider plugin's setup points Claude Code's `ANTHROPIC_BASE_URL` at a router the plugin runs on
  `127.0.0.1`, each provider on its own port.
- The router sends that provider's models to the provider with your key, another provider plugin's models to
  that plugin's router, and every `claude-*` model on to Anthropic untouched.
- Each router appends one line per request to Radar's spool (`~/.agents/radar/spool/<date>.jsonl`): the
  model, route, status, latency and tokens, with the ids Claude Code sent. The system prompt and tools a request
  carried are written once per distinct content, gzip-compressed; requests and answers pass through unchanged.
- Radar reads that spool and the transcripts Claude Code already writes and renders them into one dashboard; it
  never calls a model itself.
- Huddle runs on its own. When Radar runs on the same machine, Huddle shows Radar's alerts in its Inbox and the
  estimated cost per session in its Team view.

## Quick start

1. Add the marketplace and install a plugin in Claude Code:

   ```
   /plugin marketplace add MuhmdRaouf/claude-code-plugins
   /plugin install zai-plugin-cc@muhmdraouf
   ```

2. Restart Claude Code.
3. Run the plugin's setup command from the tables above.

- Provider plugins take your API key from `<PROVIDER>_API_KEY` (for example `ZAI_API_KEY`, `KIMI_API_KEY`), the OS
  keystore, or a one-time page in your browser, in that order. Nothing else needs configuring. See
  [API key](plugins/zai-plugin-cc/README.md#api-key) in each plugin's README.
- From a terminal: `claude plugin install <plugin>@muhmdraouf` after `claude plugin marketplace add
  MuhmdRaouf/claude-code-plugins`. Add `--scope project` to enable a plugin for one repository.

## Update

- Run `/plugin marketplace update muhmdraouf`, then restart Claude Code.

## Uninstall

### Provider plugins

Recommended: turn the plugin off first, then uninstall it.

1. Run `/<p>:remove` (for example `/zai:remove`).
2. Run `/plugin uninstall <plugin>@muhmdraouf` (for example `zai-plugin-cc@muhmdraouf`).

`/<p>:remove` restores everything setup changed, from the record it kept before changing it:

- `ANTHROPIC_BASE_URL` and the provider's models come out of `~/.claude/settings.json`; the rest of the file stays.
- The plugin's agents get back the models they had before setup.
- The API key setup stored is deleted from the OS keystore.
- The router stops serving the provider. Sessions that are already open keep working: it passes their Claude
  requests straight to Anthropic and exits once those sessions close.

State lives in `~/.agents/<p>` (a `~/.local/state/<p>` from an earlier version is moved over on the first start;
`$<P>_STATE_DIR` overrides it). Uninstalling leaves it in place, so installing again picks everything back up.

Uninstalled without `/<p>:remove` first:

- The router notices the plugin is gone and does the same cleanup on its own, from the record setup kept of what it
  changed.
- If a session still misbehaves, restart Claude Code: it then starts from the restored settings.

### Remove the marketplace

- After uninstalling every plugin, run `/plugin marketplace remove muhmdraouf`.

## Requirements

- Claude Code with plugin support.
- Bun 1.3 or later, or Node 22.3 or later (huddle: Node 22.5 or later).
- Provider plugins keep keys in the OS keystore: macOS Keychain, Linux Secret Service, or DPAPI on Windows.

## Development

```sh
npm ci
npm run check                                        # every check, as CI runs them
npm run check -w plugins/zai-plugin-cc               # one plugin
claude --plugin-dir ./plugins/zai-plugin-cc/plugin   # load a plugin from the working tree
(cd plugins/huddle && bun install && bun test && bin/rehearse)
(cd plugins/radar && bun install && bun run check)
```

- Bundles are committed, so installs need no build step. `npm run build -w <plugin>` rebuilds one.
- The five provider plugins are siblings over one core in `packages/core`; `npm run check:siblings` keeps them in step.
- [AGENTS.md](AGENTS.md) has the rules for commits and coding agents. [plugins.md](plugins.md) has the repository
  layout and architecture.

## Trademarks

- This is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic or any model
  provider.
- Claude and Claude Code are trademarks of Anthropic, PBC.
- GLM and Z.ai, Kimi and Moonshot AI, DeepSeek, MiniMax, Qwen and Alibaba Cloud, omp, opencode and pi belong to their
  respective owners. They are named only to say what the plugins work with.
- The provider plugins call each provider's public API with your own key. Your use is subject to that provider's
  terms and pricing.

## Support

<p align="center">
  If these plugins make your day a little easier, you can say thanks here:
</p>

<p align="center">
  <a href="https://github.com/sponsors/MuhmdRaouf"><img src="https://img.shields.io/badge/Sponsor_on_GitHub-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white" height="36" alt="Sponsor on GitHub"></a>&nbsp;&nbsp;<a href="https://buymeacoffee.com/muhmdraouf"><img src="https://img.shields.io/badge/Buy_me_a_coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black" height="36" alt="Buy me a coffee"></a>
</p>

- Bugs and ideas: [open an issue](https://github.com/MuhmdRaouf/claude-code-plugins/issues).

## License

[GPL-3.0-or-later](LICENSE). Copyright © 2026 [Raouf](https://github.com/MuhmdRaouf).
