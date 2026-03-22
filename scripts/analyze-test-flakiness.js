#!/usr/bin/env node

/**
 * Dynamic test flakiness analyzer.
 * Runs the test suite N times and identifies tests with inconsistent results
 * or high duration variance.
 *
 * Usage: node scripts/analyze-test-flakiness.js [--runs N] [--threshold MS]
 *   --runs N        Number of test runs (default: 5)
 *   --threshold MS  Duration stddev threshold to flag as variable (default: 50)
 *   --files GLOB    Test file glob (default: test/*.test.js)
 */

import { execSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const opts = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    threshold: { type: 'string', default: '50' },
    files: { type: 'string', default: 'test/*.test.js' },
  },
  strict: false,
}).values

const NUM_RUNS = parseInt(opts.runs, 10)
const VARIANCE_THRESHOLD = parseInt(opts.threshold, 10)
const TEST_FILES = opts.files

function parseTapOutput (tap) {
  const tests = []
  const lines = tap.split('\n')
  const suiteStack = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const subtestMatch = line.match(/^(\s*)# Subtest: (.+)/)
    if (subtestMatch) {
      const indent = subtestMatch[1].length
      const name = subtestMatch[2]
      const depth = Math.floor(indent / 4)
      suiteStack.length = depth
      suiteStack[depth] = name
      continue
    }
    const testMatch = line.match(/^(\s*)(ok|not ok) \d+ - (.+)/)
    if (!testMatch) continue
    const indent = testMatch[1].length
    const passed = testMatch[2] === 'ok'
    const name = testMatch[3]
    let duration = null
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const durMatch = lines[j].match(/duration_ms:\s*([\d.]+)/)
      if (durMatch) {
        duration = parseFloat(durMatch[1])
        break
      }
    }
    const depth = Math.floor(indent / 4)
    const suiteParts = suiteStack.slice(0, depth)
    const fullName = [...suiteParts, name].join(' > ')
    tests.push({ name: fullName, passed, duration })
  }
  return tests
}

function mean (arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function stddev (arr) {
  const m = mean(arr)
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length)
}

console.error('Running test suite ' + NUM_RUNS + ' times...')
const allRuns = []

for (let i = 0; i < NUM_RUNS; i++) {
  console.error('  Run ' + (i + 1) + '/' + NUM_RUNS + '...')
  let output
  let exitCode = 0
  try {
    output = execSync('node --test --test-reporter=tap ' + TEST_FILES, {
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    })
  } catch (err) {
    output = (err.stdout || '') + (err.stderr || '')
    exitCode = err.status || 1
  }
  allRuns.push({ run: i + 1, exitCode, tests: parseTapOutput(output) })
}

const testMap = new Map()
for (const run of allRuns) {
  for (const test of run.tests) {
    if (!testMap.has(test.name)) {
      testMap.set(test.name, { passes: 0, failures: 0, durations: [] })
    }
    const entry = testMap.get(test.name)
    if (test.passed) entry.passes++
    else entry.failures++
    if (test.duration != null) entry.durations.push(test.duration)
  }
}

const results = []
for (const [name, data] of testMap) {
  const total = data.passes + data.failures
  const flakinessRate = total > 0 ? Math.min(data.passes, data.failures) / total : 0
  const isFlaky = data.passes > 0 && data.failures > 0
  const meanDur = data.durations.length ? mean(data.durations) : null
  const stddevDur = data.durations.length > 1 ? stddev(data.durations) : null
  const isVariable = stddevDur != null && stddevDur > VARIANCE_THRESHOLD
  results.push({
    name,
    passes: data.passes,
    failures: data.failures,
    totalRuns: total,
    flakinessRate: Math.round(flakinessRate * 1000) / 1000,
    isFlaky,
    duration: {
      mean: meanDur != null ? Math.round(meanDur * 100) / 100 : null,
      stddev: stddevDur != null ? Math.round(stddevDur * 100) / 100 : null,
      min: data.durations.length ? Math.round(Math.min(...data.durations) * 100) / 100 : null,
      max: data.durations.length ? Math.round(Math.max(...data.durations) * 100) / 100 : null,
    },
    isVariable,
  })
}

const flakyTests = results.filter(r => r.isFlaky)
const variableTests = results.filter(r => r.isVariable)
const slowTests = results
  .filter(r => r.duration.mean != null)
  .sort((a, b) => b.duration.mean - a.duration.mean)
  .slice(0, 10)

const report = {
  meta: {
    runs: NUM_RUNS,
    totalTests: results.length,
    varianceThreshold: VARIANCE_THRESHOLD,
    timestamp: new Date().toISOString(),
  },
  summary: {
    flakyCount: flakyTests.length,
    variableCount: variableTests.length,
    allPassed: flakyTests.length === 0,
  },
  flakyTests,
  variableTests,
  slowestTests: slowTests,
}

console.log(JSON.stringify(report, null, 2))
