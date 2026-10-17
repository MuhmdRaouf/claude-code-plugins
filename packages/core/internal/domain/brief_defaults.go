package domain

const DefaultTimeoutMs = 2 * 3_600_000

const DefaultBase = "HEAD"

// DefaultRetries is the retry counts a brief gets when it names none. Treat it as read-only.
var DefaultRetries = Retries{Fix: 1, Infra: 2}

const DefaultGateTimeoutMs = 10 * 60_000

// DefaultReport is the report contract each mode falls back to. Treat it as read-only.
var DefaultReport = map[Mode]BuiltinReport{
	ModeEdit:     BuiltinReportChange,
	ModeExec:     BuiltinReportSweep,
	ModeReadonly: BuiltinReportNotes,
}

// DefaultScope is the scope each mode falls back to. Treat it as read-only.
var DefaultScope = map[Mode][]string{
	ModeEdit:     {"**"},
	ModeExec:     {},
	ModeReadonly: {},
}

// WithDefaults fills the defaults that depend on the mode (and the caller's directory and
// provider).
func WithDefaults(fields FrontMatter, body string, ctx BriefContext) Brief {
	mode := fields.Mode
	brief := Brief{
		Title:     fields.Title,
		Body:      body,
		Model:     ctx.Provider.DefaultTier[mode],
		Mode:      mode,
		Cwd:       ctx.DefaultCwd,
		Base:      fields.Base,
		Scope:     DefaultScope[mode],
		Forbid:    fields.Forbid,
		Gates:     fields.Gates,
		TimeoutMs: fields.Timeout,
		Retries:   fields.Retries,
		Report:    Report{Kind: ReportKindBuiltin, Name: DefaultReport[mode]},
		AddDirs:   fields.AddDirs,
		Env:       fields.Env,
		Tags:      fields.Tags,
	}
	if fields.Model != nil {
		brief.Model = *fields.Model
	}
	// The optional fields stay absent when the front matter carried none.
	brief.Effort = fields.Effort
	brief.Priority = fields.Priority
	if fields.Cwd != nil {
		brief.Cwd = *fields.Cwd
	}
	if fields.Scope != nil {
		brief.Scope = *fields.Scope
	}
	brief.Setup = fields.Setup
	brief.Regenerate = fields.Regenerate
	if fields.Report != nil {
		brief.Report = *fields.Report
	}
	brief.BudgetUSD = fields.BudgetUSD
	brief.Engine = fields.Engine
	// claude stays implicit, so a claude job's brief reads exactly as it did before engines
	// existed.
	if brief.Engine != nil && *brief.Engine == EngineTool(EngineClaude) {
		brief.Engine = nil
	}
	return brief
}
