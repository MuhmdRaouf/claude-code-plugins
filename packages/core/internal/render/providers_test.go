package render

import (
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/providers"
)

// The five provider plugins side by side — the rules no single plugin can check alone (unique
// ports, env prefixes, agent names, model prefixes that never claim another plugin's models) and
// the price sheet each one's catalog must be on.

// pluginProviders is the five providers in alphabetical order, each checked to live in its own
// <name>-plugin-cc.
func pluginProviders(t *testing.T) []domain.Provider {
	t.Helper()
	names := append([]string{}, providers.Names...)
	slices.Sort(names)
	list := make([]domain.Provider, 0, len(names))
	for _, name := range names {
		provider, ok := providers.ByName(name)
		if !ok {
			t.Fatalf("%s: providers has no such provider", name)
		}
		dir := filepath.Join("..", "..", "..", "..", "plugins", name+"-plugin-cc")
		if _, err := os.Stat(dir); err != nil {
			t.Fatalf("%s plugin dir: %v", name, err)
		}
		list = append(list, provider)
	}
	return list
}

// They are the five providers, each in its own <name>-plugin-cc.
func TestProviderPluginsAreTheFive(t *testing.T) {
	list := pluginProviders(t)
	want := []string{"deepseek", "kimi", "minimax", "qwen", "zai"}
	if len(list) != len(want) {
		t.Fatalf("%d providers, want %d", len(list), len(want))
	}
	for i, provider := range list {
		if provider.Name != want[i] {
			t.Errorf("provider %d is %q, want %q", i, provider.Name, want[i])
		}
	}
}

// They never share a name, port, env prefix, key variable, key file, state root, display name or
// agent.
func TestProviderPluginsShareNothing(t *testing.T) {
	list := pluginProviders(t)
	unique := func(what string, pick func(domain.Provider) []string) {
		var all []string
		for _, provider := range list {
			all = append(all, pick(provider)...)
		}
		for i, value := range all {
			if slices.Contains(all[:i], value) {
				t.Errorf("%s shared between providers: %q", what, value)
			}
		}
	}
	unique("name", func(p domain.Provider) []string { return []string{p.Name} })
	unique("display name", func(p domain.Provider) []string { return []string{p.Display} })
	unique("router port", func(p domain.Provider) []string { return []string{strconv.Itoa(p.Router.Port)} })
	unique("router label", func(p domain.Provider) []string { return []string{p.Router.Label} })
	unique("env prefix", func(p domain.Provider) []string { return []string{p.EnvPrefix} })
	unique("key variable", func(p domain.Provider) []string { return p.KeyEnv })
	unique("key file", func(p domain.Provider) []string { return []string{p.KeyFile} })
	unique("state dir variable", func(p domain.Provider) []string {
		return []string{adapters.NewStateRootRule(p).EnvVar}
	})
	unique("agent", func(p domain.Provider) []string {
		return []string{
			p.AgentPrefix + p.Agents[domain.ModelTierMain],
			p.AgentPrefix + p.Agents[domain.ModelTierFlash],
		}
	})
	unique("model id", func(p domain.Provider) []string {
		return []string{p.Catalog[domain.ModelTierMain].ID, p.Catalog[domain.ModelTierFlash].ID}
	})
}

// They route only their own models: each catalog id is claimed by its own router's prefixes and
// no other's.
func TestProviderPluginsRouteOnlyTheirOwnModels(t *testing.T) {
	list := pluginProviders(t)
	for _, owner := range list {
		for _, tier := range []domain.ModelTier{domain.ModelTierMain, domain.ModelTierFlash} {
			id := owner.Catalog[tier].ID
			var claimants []string
			for _, p := range list {
				for _, prefix := range p.Router.ModelPrefixes {
					if strings.HasPrefix(id, prefix) {
						claimants = append(claimants, p.Name)
						break
					}
				}
			}
			if len(claimants) != 1 || claimants[0] != owner.Name {
				t.Errorf("%s: claimants %v, want [%s]", id, claimants, owner.Name)
			}
		}
		for _, prefix := range owner.Router.ModelPrefixes {
			if regexp.MustCompile(`(?i)^claude`).MatchString(prefix) {
				t.Errorf("%s: prefix %q claims Claude's models", owner.Name, prefix)
			}
		}
	}
}

// Models whose window is far below the 1M a behavesAs hint could name: without a hint Claude Code
// keeps its standard window for an unknown id, which fits them, where a 1M hint would let a
// session outgrow the provider's window before auto-compact starts.
var noWindowHint = map[string]string{
	"kimi-k2.6":              "262,144-token window (platform.kimi.ai/docs/pricing/chat, 2026-10-09)",
	"MiniMax-M2.7-highspeed": "204,800-token window (platform.minimax.io/docs/api-reference/text-anthropic-api, 2026-10-09)",
}

// Every catalog model gets a behavesAs window hint, unless its window is far smaller.
func TestProviderModelsGetAWindowHint(t *testing.T) {
	for _, provider := range pluginProviders(t) {
		for _, tier := range []domain.ModelTier{domain.ModelTierMain, domain.ModelTierFlash} {
			ref := provider.Catalog[tier]
			if _, exempt := noWindowHint[ref.ID]; exempt {
				if ref.BehavesAs != nil {
					t.Errorf("%s: %s must not borrow a larger window", provider.Name, ref.ID)
				}
				continue
			}
			if ref.BehavesAs == nil || !strings.HasPrefix(*ref.BehavesAs, "claude-") {
				t.Errorf("%s: %s declares no behavesAs and none is exempted", provider.Name, ref.ID)
			}
		}
	}
}

// Catalog fields a model may ship without, and why: the provider publishes no figure to copy
// (each entry says where the plugins looked, as prices.go cites its sources).
var unpublishedOutputCap = map[string]string{
	"kimi-k2.6":              "Moonshot publishes no output cap for it, only the 262,144-token window (platform.kimi.ai/docs/pricing/chat, 2026-10-09)",
	"MiniMax-M3":             "MiniMax publishes no output cap; the window is 1,000,000 (platform.minimax.io/docs/api-reference/text-anthropic-api, 2026-10-09)",
	"MiniMax-M2.7-highspeed": "MiniMax publishes no output cap; the window is 204,800 (platform.minimax.io/docs/api-reference/text-anthropic-api, 2026-10-09)",
	"qwen3.8-max":            "Alibaba Cloud publishes no output cap for Model Studio models; the window is 1M (help.aliyun.com/zh/model-studio/text-generation-model, 2026-10-09)",
	"qwen3.8-flash":          "Alibaba Cloud publishes no output cap for Model Studio models; the window is 1M (help.aliyun.com/zh/model-studio/text-generation-model, 2026-10-09)",
}

// Every catalog model gets an output cap, or the documented exemption.
func TestProviderModelsGetAnOutputCap(t *testing.T) {
	for _, provider := range pluginProviders(t) {
		for _, tier := range []domain.ModelTier{domain.ModelTierMain, domain.ModelTierFlash} {
			ref := provider.Catalog[tier]
			if ref.MaxOutputTokens == nil {
				if _, exempt := unpublishedOutputCap[ref.ID]; !exempt {
					t.Errorf("%s: %s declares no maxOutputTokens and none is exempted", provider.Name, ref.ID)
				}
				continue
			}
			if *ref.MaxOutputTokens <= 0 {
				t.Errorf("%s: %s maxOutputTokens %d is not positive", provider.Name, ref.ID, *ref.MaxOutputTokens)
			}
		}
	}
}

// pluginMarkdown is every markdown file a plugin ships: the copy users read.
func pluginMarkdown(t *testing.T, pluginDir string) []string {
	t.Helper()
	var files []string
	err := filepath.WalkDir(pluginDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "node_modules" {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(entry.Name(), ".md") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", pluginDir, err)
	}
	return files
}

// The provider's price sheet, found by the host its endpoint shares with it.
func providerSheet(t *testing.T, provider domain.Provider) *Offering {
	t.Helper()
	parsed, err := url.Parse(provider.BaseURL)
	if err != nil {
		t.Fatalf("%s: parse %q: %v", provider.Name, provider.BaseURL, err)
	}
	for i := range Offerings {
		if Offerings[i].Host == parsed.Hostname() {
			return &Offerings[i]
		}
	}
	return nil
}

// No plugin calls the flash tier cheaper where the price sheet prices it above the main model.
func TestProviderPluginsNeverCallFlashCheaperUnpriced(t *testing.T) {
	cheaperWord := regexp.MustCompile(`(?i)\bcheaper\b`)
	for _, provider := range pluginProviders(t) {
		offering := providerSheet(t, provider)
		if offering == nil {
			t.Errorf("%s: no offering shares its endpoint host", provider.Name)
			continue
		}
		main, mainOK := offering.Models[provider.Catalog[domain.ModelTierMain].ID]
		flash, flashOK := offering.Models[provider.Catalog[domain.ModelTierFlash].ID]
		if !mainOK {
			t.Errorf("%s: %s not on the sheet", provider.Name, provider.Catalog[domain.ModelTierMain].ID)
		}
		if !flashOK {
			t.Errorf("%s: %s not on the sheet", provider.Name, provider.Catalog[domain.ModelTierFlash].ID)
		}
		if !mainOK || !flashOK {
			continue
		}
		flashCheaper := flash.Base.Input < main.Base.Input && flash.Base.Output < main.Base.Output
		if flashCheaper {
			continue
		}
		for _, file := range pluginMarkdown(t,
			filepath.Join("..", "..", "..", "..", "plugins", provider.Name+"-plugin-cc")) {
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("read %s: %v", file, err)
			}
			if cheaperWord.Match(raw) {
				t.Errorf("%s calls %s cheaper; the price sheet (%s) does not agree",
					file, provider.Catalog[domain.ModelTierFlash].ID, offering.Source)
			}
		}
	}
}
