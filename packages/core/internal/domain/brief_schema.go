package domain

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// FrontMatter is the brief's front-matter fields validated and normalised, with the
// mode-independent defaults applied; the rest depend on the mode.
type FrontMatter struct {
	Title      string
	Model      *ModelTier
	Effort     *string
	Mode       Mode
	Priority   *Priority
	Cwd        *string
	Base       string
	Scope      *[]string
	Forbid     []string
	Gates      []Gate
	Setup      *[]string
	Regenerate *[]regenerateRule
	Timeout    int64
	Retries    Retries
	Report     *Report
	AddDirs    []string
	Env        []string
	BudgetUSD  *float64
	Tags       []string
	Engine     *EngineTool
}

const unknownFieldMessage = "unknown field"

var shellVariableName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ParseFrontMatter validates the parsed YAML of a brief's front matter field by field, in the
// schema's field order, with the exact field errors the brief errors pin: every invalid field at
// once, shape fields before unknown keys, unknown keys in document order.
func ParseFrontMatter(data any, ctx BriefContext) (FrontMatter, []BriefError) {
	root, ok := data.(yamlMap)
	if !ok {
		if data != nil {
			return FrontMatter{}, []BriefError{fieldError("front matter", typeMessage("object", data))}
		}
		root = yamlMap{values: map[string]any{}}
	}
	var errors []BriefError
	fields := FrontMatter{}
	add := func(field, message string) {
		errors = append(errors, fieldError(field, message))
	}

	// title: a trimmed, non-empty string, required.
	if value, present := root.get("title"); !present {
		add("title", "required")
	} else if text, message, ok := checkText(value); ok {
		fields.Title = text
	} else {
		add("title", message)
	}

	// model: a tier, named by the name the provider gives it or by its catalog model id.
	tierNames, tierByName := tierCatalog(ctx.Provider)
	if value, present := root.get("model"); present {
		if text, message, ok := checkText(value); !ok {
			add("model", message)
		} else if tier, found := tierByName[text]; found {
			fields.Model = &tier
		} else {
			add("model", "must be one of "+strings.Join(tierNames, ", "))
		}
	}

	// effort: one of the worker's efforts, which spells its own message.
	if value, present := root.get("effort"); present {
		if effort, message, ok := checkEnum(value, ctx.Worker.Efforts, true); ok {
			fields.Effort = &effort
		} else {
			add("effort", message)
		}
	}

	// mode: what the job may do, edit by default.
	if value, present := root.get("mode"); present {
		if mode, message, ok := checkEnum(value, []string{string(ModeEdit), string(ModeExec), string(ModeReadonly)}, false); ok {
			fields.Mode = Mode(mode)
		} else {
			add("mode", message)
		}
	} else {
		fields.Mode = ModeEdit
	}

	if value, present := root.get("priority"); present {
		if priority, message, ok := checkEnum(value, []string{string(PriorityHigh), string(PriorityNormal)}, false); ok {
			priority := Priority(priority)
			fields.Priority = &priority
		} else {
			add("priority", message)
		}
	}

	// cwd and addDirs resolve against the caller's directory.
	if value, present := root.get("cwd"); present {
		if text, message, ok := checkText(value); ok {
			cwd := resolvePath(ctx.DefaultCwd, text)
			fields.Cwd = &cwd
		} else {
			add("cwd", message)
		}
	}

	if value, present := root.get("base"); present {
		if text, message, ok := checkText(value); ok {
			fields.Base = text
		} else {
			add("base", message)
		}
	} else {
		fields.Base = DefaultBase
	}

	if value, present := root.get("scope"); present {
		if items, ok := checkTextArray(value, "scope", &errors); ok {
			fields.Scope = &items
		}
	}

	if value, present := root.get("forbid"); !present {
		fields.Forbid = []string{}
	} else if items, ok := checkTextArray(value, "forbid", &errors); ok {
		fields.Forbid = items
	}

	if value, present := root.get("gates"); !present {
		fields.Gates = []Gate{}
	} else if items, ok := value.([]any); !ok {
		add("gates", typeMessage("array", value))
	} else {
		gates := make([]Gate, 0, len(items))
		valid := true
		for index, item := range items {
			if gate, ok := checkGate(item, index, &errors); ok {
				gates = append(gates, gate)
			} else {
				valid = false
			}
		}
		if valid {
			fields.Gates = gates
		}
	}

	if value, present := root.get("setup"); present {
		if items, ok := checkTextArray(value, "setup", &errors); ok {
			fields.Setup = &items
		}
	}

	if value, present := root.get("regenerate"); present {
		if items, ok := value.([]any); !ok {
			add("regenerate", typeMessage("array", value))
		} else {
			rules := make([]regenerateRule, 0, len(items))
			valid := true
			for index, item := range items {
				if rule, ok := checkRegenerateRule(item, index, &errors); ok {
					rules = append(rules, rule)
				} else {
					valid = false
				}
			}
			if valid {
				fields.Regenerate = &rules
			}
		}
	}

	if value, present := root.get("timeout"); !present {
		fields.Timeout = DefaultTimeoutMs
	} else if ms, message, ok := checkDuration(value); ok {
		fields.Timeout = ms
	} else {
		add("timeout", message)
	}

	if value, present := root.get("retries"); !present {
		fields.Retries = DefaultRetries
	} else if retries, ok := checkRetries(value, &errors); ok {
		fields.Retries = retries
	}

	if value, present := root.get("report"); present {
		if text, message, ok := checkText(value); !ok {
			add("report", message)
		} else if report, ok := reportContract(text, ctx.DefaultCwd); ok {
			fields.Report = &report
		} else {
			add("report", "must be change, sweep, notes or a path to a .json schema")
		}
	}

	if value, present := root.get("addDirs"); !present {
		fields.AddDirs = []string{}
	} else if items, ok := checkPathArray(value, "addDirs", ctx.DefaultCwd, &errors); ok {
		fields.AddDirs = items
	}

	if value, present := root.get("env"); !present {
		fields.Env = []string{}
	} else if items, ok := value.([]any); !ok {
		add("env", typeMessage("array", value))
	} else {
		names := make([]string, 0, len(items))
		valid := true
		for index, item := range items {
			name, ok := item.(string)
			if !ok {
				add(indexedField("env", index), typeMessage("string", item))
				valid = false
				continue
			}
			if !shellVariableName.MatchString(name) {
				add(indexedField("env", index), "must be a shell variable name")
				valid = false
				continue
			}
			names = append(names, name)
		}
		if valid {
			fields.Env = names
		}
	}

	if value, present := root.get("budgetUsd"); present {
		if budget, message, ok := checkBudget(value, ctx.Worker.Budget); ok {
			fields.BudgetUSD = &budget
		} else {
			add("budgetUsd", message)
		}
	}

	if value, present := root.get("tags"); !present {
		fields.Tags = []string{}
	} else if items, ok := checkTextArray(value, "tags", &errors); ok {
		fields.Tags = items
	}

	if value, present := root.get("engine"); present {
		names := make([]string, 0, len(ENGINES))
		for _, engine := range ENGINES {
			names = append(names, string(engine))
		}
		if engine, message, ok := checkEnum(value, names, true); ok {
			engine := EngineTool(engine)
			fields.Engine = &engine
		} else {
			add("engine", message)
		}
	}

	// Unknown keys come last, in document order.
	for _, key := range root.keys {
		if !knownFrontMatterKey(key) {
			add(key, unknownFieldMessage)
		}
	}
	return fields, errors
}

// fieldError builds a field error; an empty path reads "front matter".
func fieldError(path, message string) BriefError {
	return BriefError{Kind: BriefErrorField, Field: path, Message: message}
}

func typeMessage(expected string, value any) string {
	return "Invalid input: expected " + expected + ", received " + jsTypeName(value)
}

func indexedField(field string, index int) string {
	return field + "." + strconv.Itoa(index)
}

// checkText is z.string().trim().min(1): trims, then rejects the empty string.
func checkText(value any) (string, string, bool) {
	text, ok := value.(string)
	if !ok {
		return "", typeMessage("string", value), false
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", "must not be empty", false
	}
	return trimmed, "", true
}

// checkEnum is z.enum: a string among the values. custom=false builds zod's own message;
// custom=true the "must be one of ..." the schema passes for effort and engine.
func checkEnum(value any, values []string, custom bool) (string, string, bool) {
	text, ok := value.(string)
	if ok {
		for _, candidate := range values {
			if text == candidate {
				return candidate, "", true
			}
		}
	}
	return "", enumMessage(values, custom), false
}

func enumMessage(values []string, custom bool) string {
	if custom {
		return "must be one of " + strings.Join(values, ", ")
	}
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, `"`+value+`"`)
	}
	return "Invalid option: expected one of " + strings.Join(quoted, "|")
}

// tierCatalog maps every name a brief may name a tier with (tier name, catalog id) to the tier,
// keeping the provider's order for the error message.
func tierCatalog(provider Provider) ([]string, map[string]ModelTier) {
	names := make([]string, 0, 4)
	byName := make(map[string]ModelTier, 4)
	for _, tier := range []ModelTier{ModelTierMain, ModelTierFlash} {
		for _, name := range []string{provider.TierNames[tier], provider.Catalog[tier].ID} {
			if _, exists := byName[name]; !exists {
				byName[name] = tier
				names = append(names, name)
			}
		}
	}
	return names, byName
}

// checkDuration is the duration union: a string or finite number ParseDuration accepts. zod's
// union rejects non-finite numbers outright, and anything else gets its "Invalid input".
func checkDuration(value any) (int64, string, bool) {
	switch typed := value.(type) {
	case string, int64:
		ms, err := ParseDuration(value)
		if err != nil {
			return 0, err.Error(), false
		}
		return ms, "", true
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, "Invalid input", false
		}
		ms, err := ParseDuration(value)
		if err != nil {
			return 0, err.Error(), false
		}
		return ms, "", true
	default:
		return 0, "Invalid input", false
	}
}

// checkCount is z.int().min(0): the base type error names "number", the whole-number check
// "int".
func checkCount(value any) (int64, string, bool) {
	switch typed := value.(type) {
	case int64:
		if typed < 0 {
			return 0, "Too small: expected number to be >=0", false
		}
		return typed, "", true
	case float64:
		if typed != math.Trunc(typed) {
			return 0, typeMessage("int", value), false
		}
		if typed < 0 {
			return 0, "Too small: expected number to be >=0", false
		}
		return int64(typed), "", true
	default:
		return 0, typeMessage("number", value), false
	}
}

// checkBudget is z.number().positive(), plus the refusal when the worker has no spending cap.
func checkBudget(value any, budgetSupported bool) (float64, string, bool) {
	number, ok := jsNumber(value)
	if !ok {
		return 0, typeMessage("number", value), false
	}
	if !(number > 0) {
		return 0, "Too small: expected number to be >0", false
	}
	if !budgetSupported {
		return 0, "the worker has no spending cap; use timeout", false
	}
	return number, "", true
}

func jsNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case int64:
		return float64(typed), true
	case float64:
		return typed, true
	default:
		return 0, false
	}
}

// checkGate is the gate schema: a string preprocesses to {run}, an object is strict (run
// required, timeout a duration defaulting to 10m), anything else a type error.
func checkGate(value any, index int, errors *[]BriefError) (Gate, bool) {
	field := "gates." + strconv.Itoa(index)
	var mapping yamlMap
	switch typed := value.(type) {
	case string:
		mapping = yamlMap{keys: []string{"run"}, values: map[string]any{"run": typed}}
	case yamlMap:
		mapping = typed
	default:
		*errors = append(*errors, fieldError(field, typeMessage("object", value)))
		return Gate{}, false
	}
	gate := Gate{TimeoutMs: DefaultGateTimeoutMs}
	valid := true
	if run, present := mapping.get("run"); !present {
		*errors = append(*errors, fieldError(field+".run", "required"))
		valid = false
	} else if text, message, ok := checkText(run); ok {
		gate.Run = text
	} else {
		*errors = append(*errors, fieldError(field+".run", message))
		valid = false
	}
	if timeout, present := mapping.get("timeout"); present {
		if ms, message, ok := checkDuration(timeout); ok {
			gate.TimeoutMs = ms
		} else {
			*errors = append(*errors, fieldError(field+".timeout", message))
			valid = false
		}
	}
	for _, key := range mapping.keys {
		if key != "run" && key != "timeout" {
			*errors = append(*errors, fieldError(field+"."+key, unknownFieldMessage))
			valid = false
		}
	}
	return gate, valid
}

// checkRegenerateRule is the regenerate element: a strict {paths, run} object.
func checkRegenerateRule(value any, index int, errors *[]BriefError) (regenerateRule, bool) {
	field := "regenerate." + strconv.Itoa(index)
	mapping, ok := value.(yamlMap)
	if !ok {
		*errors = append(*errors, fieldError(field, typeMessage("object", value)))
		return regenerateRule{}, false
	}
	rule := regenerateRule{}
	valid := true
	if paths, present := mapping.get("paths"); !present {
		*errors = append(*errors, fieldError(field+".paths", "required"))
		valid = false
	} else if items, ok := checkTextArray(paths, field+".paths", errors); ok {
		rule.Paths = items
	} else {
		valid = false
	}
	if run, present := mapping.get("run"); !present {
		*errors = append(*errors, fieldError(field+".run", "required"))
		valid = false
	} else if text, message, ok := checkText(run); ok {
		rule.Run = text
	} else {
		*errors = append(*errors, fieldError(field+".run", message))
		valid = false
	}
	for _, key := range mapping.keys {
		if key != "paths" && key != "run" {
			*errors = append(*errors, fieldError(field+"."+key, unknownFieldMessage))
			valid = false
		}
	}
	return rule, valid
}

// checkRetries is the strict retries object with per-count defaults.
func checkRetries(value any, errors *[]BriefError) (Retries, bool) {
	mapping, ok := value.(yamlMap)
	if !ok {
		*errors = append(*errors, fieldError("retries", typeMessage("object", value)))
		return Retries{}, false
	}
	retries := DefaultRetries
	valid := true
	if fix, present := mapping.get("fix"); present {
		if count, message, ok := checkCount(fix); ok {
			retries.Fix = count
		} else {
			*errors = append(*errors, fieldError("retries.fix", message))
			valid = false
		}
	}
	if infra, present := mapping.get("infra"); present {
		if count, message, ok := checkCount(infra); ok {
			retries.Infra = count
		} else {
			*errors = append(*errors, fieldError("retries.infra", message))
			valid = false
		}
	}
	for _, key := range mapping.keys {
		if key != "fix" && key != "infra" {
			*errors = append(*errors, fieldError("retries."+key, unknownFieldMessage))
			valid = false
		}
	}
	return retries, valid
}

// reportContract is a builtin name or a .json path resolved against the caller's directory.
func reportContract(value, defaultCwd string) (Report, bool) {
	switch value {
	case string(BuiltinReportChange), string(BuiltinReportSweep), string(BuiltinReportNotes):
		return Report{Kind: ReportKindBuiltin, Name: BuiltinReport(value)}, true
	}
	if strings.HasSuffix(value, ".json") {
		return Report{Kind: ReportKindFile, Path: resolvePath(defaultCwd, value)}, true
	}
	return Report{}, false
}

// resolvePath is path.resolve(defaultCwd, value): an absolute value cleans, a relative one
// joins.
func resolvePath(defaultCwd, value string) string {
	return ResolvePath(defaultCwd, value)
}

// checkTextArray is z.array(text): every element a trimmed, non-empty string.
func checkTextArray(value any, field string, errors *[]BriefError) ([]string, bool) {
	items, ok := value.([]any)
	if !ok {
		*errors = append(*errors, fieldError(field, typeMessage("array", value)))
		return nil, false
	}
	texts := make([]string, 0, len(items))
	valid := true
	for index, item := range items {
		if text, message, ok := checkText(item); ok {
			texts = append(texts, text)
		} else {
			*errors = append(*errors, fieldError(indexedField(field, index), message))
			valid = false
		}
	}
	return texts, valid
}

// checkPathArray is z.array(path): every element resolved against the caller's directory.
func checkPathArray(value any, field, defaultCwd string, errors *[]BriefError) ([]string, bool) {
	items, ok := value.([]any)
	if !ok {
		*errors = append(*errors, fieldError(field, typeMessage("array", value)))
		return nil, false
	}
	paths := make([]string, 0, len(items))
	valid := true
	for index, item := range items {
		if text, message, ok := checkText(item); ok {
			paths = append(paths, resolvePath(defaultCwd, text))
		} else {
			*errors = append(*errors, fieldError(indexedField(field, index), message))
			valid = false
		}
	}
	return paths, valid
}

// knownFrontMatterKey lists every key the strict object accepts.
func knownFrontMatterKey(key string) bool {
	switch key {
	case "title", "model", "effort", "mode", "priority", "cwd", "base", "scope", "forbid",
		"gates", "setup", "regenerate", "timeout", "retries", "report", "addDirs", "env",
		"budgetUsd", "tags", "engine":
		return true
	}
	return false
}
