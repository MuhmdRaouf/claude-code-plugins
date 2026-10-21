<p align="center">
  <img src="assets/banner.svg" alt="claude-code-plugins: a marketplace of Claude Code plugins" width="100%"/>
</p>

# Moved to huddle

This repository is archived. The `muhmdraouf` marketplace and all six plugins (huddle, zai, kimi, deepseek, minimax,
qwen) now live in **[MuhmdRaouf/huddle](https://github.com/MuhmdRaouf/huddle)**, served by one Go binary:
huddle-router alone for the provider plugins, or the full edition with the hub, radar and kanban.

## Switch your install

The marketplace keeps its name, so plugin names and settings stay the same.

1. Point the marketplace at huddle:

   ```sh
   claude plugin marketplace remove muhmdraouf
   claude plugin marketplace add MuhmdRaouf/huddle
   ```

2. Install the plugins you use again, for example:

   ```sh
   claude plugin install huddle@muhmdraouf
   claude plugin install zai-plugin-cc@muhmdraouf
   ```

3. Restart Claude Code. The first session builds or downloads the huddle binary and takes over the old routers'
   ports (18787 to 18791), so open sessions keep working.

## Where things went

| Here | In huddle |
|---|---|
| `packages/core` (the plugin-core engine) | `internal/core` in the huddle binary |
| `plugins/<provider>-plugin-cc` | `plugins/<provider>-plugin-cc` |
| `plugins/huddle`, `plugins/radar` | `plugin/`, the hub's radar and kanban tabs |
| Issues and security reports | [huddle issues](https://github.com/MuhmdRaouf/huddle/issues) |

The code here stays readable for reference and is not maintained.
