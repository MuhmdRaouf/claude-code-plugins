---
title: Rename the helper
model: flash
effort: high
mode: edit
priority: normal
cwd: /work/other
base: main
scope: ["src/**", "test/**"]
forbid: ["src/generated/**"]
gates:
  - npm test
  - { run: npm run lint, timeout: 5m }
setup:
  - npm ci
regenerate:
  - { paths: [package-lock.json], run: npm install --package-lock-only }
timeout: 30m
retries: { fix: 3, infra: 0 }
report: notes
addDirs: [/opt/shared]
env: [GITHUB_TOKEN]
budgetUsd: 2.5
tags: [rename, batch-7]
engine: omp
---
Rename `foo` to `bar` everywhere.
