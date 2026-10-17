package app

import (
	"context"

	"gopkg.in/yaml.v3"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Which engine a job runs on and the worker that runs it. The job's engine is `run --engine` > the
// brief's `engine:` > the config's defaultEngine > claude; a delegation engine must be enabled by
// its setup command (every provider offers all four, each run as the user set it up). Everything
// past submission reads the engine from the job, so drive, gates, review and the decisions stay
// engine-agnostic.

// JobEngine is the engine a stored job runs on: absent (every job from before engines) means
// claude.
func JobEngine(job domain.Job) domain.Engine {
	if job.Brief.Engine != nil {
		return domain.Engine(*job.Brief.Engine)
	}
	return domain.EngineClaude
}

// WorkerOf is the worker for an engine: claude's own, or the tool's; nil when this process wired no
// engines.
func WorkerOf(deps Deps, engine domain.Engine) ports.Worker {
	if engine == domain.EngineClaude {
		return deps.Worker
	}
	if deps.Engines == nil {
		return nil
	}
	return deps.Engines.Worker(domain.EngineTool(engine))
}

// DepsForJob is the deps a job's driver runs with: the job's engine as the worker. An engine that
// cannot run here refuses to start, so the attempt fails visibly instead of running on another
// engine.
func DepsForJob(deps Deps, job domain.Job) Deps {
	engine := JobEngine(job)
	if engine == domain.EngineClaude {
		return deps
	}
	worker := WorkerOf(deps, engine)
	if worker == nil {
		worker = newUnavailableWorker(deps.Worker.Caps(), domain.EngineTool(engine))
	}
	next := deps
	next.Worker = worker
	return next
}

// BriefEngine is the engine `engine:` names in the brief's front matter, when it names a known one;
// the schema reports the rest.
func BriefEngine(text string) *domain.Engine {
	document, ok := domain.SplitFrontMatter(text)
	if !ok {
		return nil
	}
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(document.FrontMatter), &doc); err != nil {
		return nil
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return nil
	}
	root := doc.Content[0]
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value != "engine" {
			continue
		}
		value := root.Content[i+1]
		if value.Kind == yaml.ScalarNode && domain.IsEngine(value.Value) {
			engine := domain.Engine(value.Value)
			return &engine
		}
		return nil
	}
	return nil
}

// ResolveEngine is the job's engine by precedence, refused when it is not enabled.
func ResolveEngine(deps Deps, requested *domain.Engine, briefText string) (domain.Engine, error) {
	config := deps.EngineConfig.Read()
	engine := domain.EngineClaude
	if requested != nil {
		engine = *requested
	} else if brief := BriefEngine(briefText); brief != nil {
		engine = *brief
	} else if config.DefaultEngine != nil {
		engine = *config.DefaultEngine
	}
	if engine == domain.EngineClaude {
		return engine, nil
	}
	if !domain.EngineEnabled(config, engine) {
		return "", &AppError{Kind: AppErrorEngineNotEnabled, Engine: domain.EngineTool(engine)}
	}
	return engine, nil
}

// unavailableWorker is a worker whose every start fails: the stand-in for an engine this process
// cannot build.
type unavailableWorker struct {
	caps    ports.WorkerCapabilities
	refusal *ports.WorkerError
}

func newUnavailableWorker(caps ports.WorkerCapabilities, engine domain.EngineTool) unavailableWorker {
	return unavailableWorker{
		caps: caps,
		refusal: &ports.WorkerError{
			Kind:    ports.WorkerErrorUnsupported,
			Message: "the " + string(engine) + " engine is not available here",
		},
	}
}

func (w unavailableWorker) Caps() ports.WorkerCapabilities { return w.caps }

func (w unavailableWorker) Preflight(context.Context) error { return w.refusal }

func (w unavailableWorker) Start(context.Context, ports.WorkerSpec) (ports.WorkerRun, error) {
	return nil, w.refusal
}

func (w unavailableWorker) ParseLine(string) []domain.WorkerEvent { return nil }

func (w unavailableWorker) Dispose(context.Context) error { return nil }
