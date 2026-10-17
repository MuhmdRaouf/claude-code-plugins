package domain

// The per-tier quality ledger the orchestrator reports. Per model tier, over decided jobs
// (accepted|discarded) unless noted:
//   - Jobs: all jobs; Decided, Accepted, Discarded
//   - FirstTryPassRate: share of decided jobs whose FIRST attempt verdict was pass
//   - AcceptRate: accepted / decided
//   - MeanAttemptsToAccept: mean attempts over accepted jobs
//   - ReviewReturns: total review_fix attempts
//   - tokens/cost/rateLimitRetries/durationMs: sums over all attempts of all jobs
//
// Rates are nil when the denominator is 0.
type TierUsage struct {
	Tier                 ModelTier `json:"tier"`
	Jobs                 int64     `json:"jobs"`
	Decided              int64     `json:"decided"`
	Accepted             int64     `json:"accepted"`
	Discarded            int64     `json:"discarded"`
	FirstTryPassRate     *float64  `json:"firstTryPassRate"`
	AcceptRate           *float64  `json:"acceptRate"`
	MeanAttemptsToAccept *float64  `json:"meanAttemptsToAccept"`
	ReviewReturns        int64     `json:"reviewReturns"`
	InputTokens          int64     `json:"inputTokens"`
	OutputTokens         int64     `json:"outputTokens"`
	CacheReadTokens      int64     `json:"cacheReadTokens"`
	CostUSD              float64   `json:"costUsd"`
	RateLimitRetries     int64     `json:"rateLimitRetries"`
	DurationMs           int64     `json:"durationMs"`
}

// tierOrder lists the tiers a usage report rows, main first.
var tierOrder = []ModelTier{ModelTierMain, ModelTierFlash}

func SummarizeUsage(jobs []Job) []TierUsage {
	// The report always carries the array; keep an empty row set marshalling as [].
	rows := make([]TierUsage, 0, len(tierOrder))
	for _, tier := range tierOrder {
		var tierJobs []Job
		for _, job := range jobs {
			if job.Brief.Model == tier {
				tierJobs = append(tierJobs, job)
			}
		}
		if len(tierJobs) == 0 {
			continue
		}
		rows = append(rows, tierUsage(tier, tierJobs))
	}
	return rows
}

func tierUsage(tier ModelTier, jobs []Job) TierUsage {
	var accepted, discarded int64
	var passedFirstTry, attemptsToAccept int64
	for _, job := range jobs {
		decided := false
		switch job.State {
		case JobStateAccepted:
			accepted++
			decided = true
			attemptsToAccept += int64(len(job.Attempts))
		case JobStateDiscarded:
			discarded++
			decided = true
		}
		// Undecided jobs do not count toward the first-try rate, even with a passing first attempt.
		if decided && firstVerdictPass(job) {
			passedFirstTry++
		}
	}
	row := TierUsage{
		Tier:                 tier,
		Jobs:                 int64(len(jobs)),
		Accepted:             accepted,
		Discarded:            discarded,
		Decided:              accepted + discarded,
		FirstTryPassRate:     ratio(passedFirstTry, accepted+discarded),
		AcceptRate:           ratio(accepted, accepted+discarded),
		MeanAttemptsToAccept: ratio(attemptsToAccept, accepted),
	}
	for _, job := range jobs {
		for _, attempt := range job.Attempts {
			if attempt.Kind == AttemptKindReviewFix {
				row.ReviewReturns++
			}
			if attempt.Usage == nil {
				continue
			}
			row.InputTokens += attempt.Usage.InputTokens
			row.OutputTokens += attempt.Usage.OutputTokens
			row.CacheReadTokens += attempt.Usage.CacheReadTokens
			row.CostUSD += attempt.Usage.CostUSD
			row.RateLimitRetries += attempt.Usage.RateLimitRetries
			row.DurationMs += attempt.Usage.DurationMs
		}
	}
	return row
}

// firstVerdictPass reports whether the job's first attempt passed.
func firstVerdictPass(job Job) bool {
	return len(job.Attempts) > 0 && job.Attempts[0].Verdict != nil && *job.Attempts[0].Verdict == VerdictPass
}

// EngineUsage is one delegation engine's share of the job loop, as the tool itself reported it per
// attempt (requests are model turns): the tool runs on its own setup, so these are its numbers and
// the models it named, not the provider's bill.
type EngineUsage struct {
	Engine EngineTool `json:"engine"`
	// The models the tool said it ran on, in its own naming, sorted; empty when it named none.
	Models           []string `json:"models"`
	Jobs             int64    `json:"jobs"`
	Accepted         int64    `json:"accepted"`
	Requests         int64    `json:"requests"`
	InputTokens      int64    `json:"inputTokens"`
	OutputTokens     int64    `json:"outputTokens"`
	CacheReadTokens  int64    `json:"cacheReadTokens"`
	CacheWriteTokens int64    `json:"cacheWriteTokens"`
	CostUSD          float64  `json:"costUsd"`
}

// SummarizeEngines rows each engine (omp, opencode, pi, zcode, in that order) over its jobs; an
// engine without jobs has no row.
func SummarizeEngines(jobs []Job) []EngineUsage {
	// The report always carries the array; keep an empty row set marshalling as [].
	rows := make([]EngineUsage, 0, len(ENGINE_TOOLS))
	for _, engine := range ENGINE_TOOLS {
		var engineJobs []Job
		for _, job := range jobs {
			if job.Brief.Engine != nil && *job.Brief.Engine == engine {
				engineJobs = append(engineJobs, job)
			}
		}
		if len(engineJobs) == 0 {
			continue
		}
		rows = append(rows, engineUsage(engine, engineJobs))
	}
	return rows
}

func engineUsage(engine EngineTool, jobs []Job) EngineUsage {
	row := EngineUsage{Engine: engine, Jobs: int64(len(jobs)), Models: []string{}}
	models := map[string]bool{}
	for _, job := range jobs {
		if job.State == JobStateAccepted {
			row.Accepted++
		}
		for _, attempt := range job.Attempts {
			if attempt.Usage == nil {
				continue
			}
			if attempt.Usage.Model != nil {
				models[*attempt.Usage.Model] = true
			}
			row.Requests += attempt.Usage.Turns
			row.InputTokens += attempt.Usage.InputTokens
			row.OutputTokens += attempt.Usage.OutputTokens
			row.CacheReadTokens += attempt.Usage.CacheReadTokens
			row.CacheWriteTokens += attempt.Usage.CacheWriteTokens
			row.CostUSD += attempt.Usage.CostUSD
		}
	}
	for model := range models {
		row.Models = append(row.Models, model)
	}
	// JS sort orders strings by UTF-16 code units.
	sortStringsUTF16(row.Models)
	return row
}

// ratio is numerator/denominator, nil when the denominator is 0.
func ratio(numerator, denominator int64) *float64 {
	if denominator == 0 {
		return nil
	}
	value := float64(numerator) / float64(denominator)
	return &value
}
