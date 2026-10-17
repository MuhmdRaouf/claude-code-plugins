// The chaos suite's child half: this binary re-executed as the chaos provider's router service
// (front, worker, starter — all one binary serves through its router entry). TestMain's mode
// switch dispatches here;
// chaos_test.go (package router_test) drives the parent's side of the rig and carries a copy of
// the provider spec the two packages cannot share. The spawn that starts a child hands it the
// mode variables below, and the front's worker fork inherits them with the front's environment.
package router

import (
	"fmt"
	"os"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// chaosChildMode is the TestMain mode of a chaos router child; chaosChildName and chaosChildState
// name the provider it serves and the state root it reads. Plain strings, not the parent's
// constants: the two halves live in different packages.
const (
	chaosChildMode  = "chaos-service"
	chaosChildName  = "chaos"
	chaosChildState = "CHAOS_CHILD_STATE"
)

// chaosChildProvider is the chaos provider: the provider the suite's router processes serve,
// with no name shared with any plugin and every port set by env. It must stay in step with
// chaosProviderSpec in chaos_test.go.
func chaosChildProvider() domain.Provider {
	return domain.DefineProvider(domain.ProviderSpec{
		Name:         "chaos",
		Display:      "Chaos Models",
		Slash:        "/chaos:",
		AgentPrefix:  "chaos:",
		BranchPrefix: "chaos/",
		Harness:      "chaos",
		ArtifactsEnv: "CHAOS_ARTIFACTS",
		EnvPrefix:    "CHAOS",
		Catalog: map[domain.ModelTier]domain.ModelRef{
			domain.ModelTierMain:  {Tier: domain.ModelTierMain, ID: "chaos-big", Label: "Chaos Big"},
			domain.ModelTierFlash: {Tier: domain.ModelTierFlash, ID: "chaos-small", Label: "Chaos Small"},
		},
		TierNames: map[domain.ModelTier]string{domain.ModelTierMain: "big", domain.ModelTierFlash: "small"},
		DefaultTier: map[domain.Mode]domain.ModelTier{
			domain.ModeEdit:     domain.ModelTierMain,
			domain.ModeExec:     domain.ModelTierFlash,
			domain.ModeReadonly: domain.ModelTierFlash,
		},
		PingTier:    domain.ModelTierFlash,
		WorkerLabel: "claude",
		BaseURL:     "http://127.0.0.1:9/anthropic",
		Auth:        domain.AuthBearer,
		KeyEnv:      []string{"CHAOS_API_KEY"},
		KeyFile:     "~/.config/chaos/env",
		BillingURL:  "https://billing.example.test/top-up",
		KeysURL:     "https://keys.example.test/api-keys",
		Router: domain.ProviderRouter{
			Port:          9,
			Label:         "test.chaos-router",
			HealthPath:    "/chaos-router/health",
			ModelPrefixes: []string{"chaos-"},
		},
	})
}

// runChaosServiceChild is the router child: argv `<name> router <command>` (the service entry) or
// `<name> passthrough` (the emergency), the environment the spawn
// handed it. Its own starts (an ensure-spawned `start`, an emergency) spawn through chaosSpawn so
// the grandchildren re-enter this mode too.
func runChaosServiceChild() {
	fail := func(line string) {
		fmt.Fprintln(os.Stderr, line)
		os.Exit(3)
	}
	shape := len(os.Args) == 4 && os.Args[1] == chaosChildName && os.Args[2] == "router"
	passthrough := len(os.Args) == 3 && os.Args[1] == chaosChildName && os.Args[2] == "passthrough"
	if !shape && !passthrough {
		fail(fmt.Sprintf("chaos child argv = %v", os.Args))
	}
	env := domain.EnvLookup{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		env[name] = value
	}
	provider := chaosChildProvider()
	if passthrough {
		resolved := domain.ResolveProvider(provider, env)
		err := RunEmergency(EmergencyProvider{
			Name:       resolved.Name,
			Display:    resolved.Display,
			EnvPrefix:  resolved.EnvPrefix,
			HealthPath: resolved.Router.HealthPath,
			Port:       resolved.Router.Port,
			Claim:      resolved.ModelClaim(),
		}, env, nil)
		if err != nil {
			fail("chaos passthrough: " + err.Error())
		}
		os.Exit(0)
	}
	stateRoot := os.Getenv(chaosChildState)
	self, err := os.Executable()
	if err != nil {
		fail("no executable: " + err.Error())
	}
	os.Exit(RouterService(RouterServiceOptions{
		Provider:  provider,
		StateRoot: stateRoot,
		Script:    self,
		Env:       env,
		Argv:      os.Args[3:],
		Spawn:     chaosSpawn,
	}))
}

// chaosSpawn is the production detached spawn with the child's mode variables added, so a router
// the service starts re-enters the chaos child mode.
func chaosSpawn(binary string, args []string, env map[string]string, logFile string) DetachedChild {
	merged := make(map[string]string, len(env)+3)
	for name, value := range env {
		merged[name] = value
	}
	merged[focusChildEnv] = chaosChildMode
	merged[chaosChildState] = os.Getenv(chaosChildState)
	return spawnRouterDetached(binary, args, merged, logFile)
}
