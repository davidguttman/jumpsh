#!/usr/bin/env node

/**
 * Static flaky-pattern scanner for test files.
 * Detects common anti-patterns that cause test flakiness.
 *
 * Usage: node scripts/scan-flaky-patterns.js [--dir DIR]
 *   --dir DIR  Directory to scan (default: test)
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const opts = parseArgs({
  options: {
    dir: { type: 'string', default: 'test' },
  },
  strict: false,
}).values

const PATTERNS = [
  {
    id: 'hardcoded-timeout',
    description: 'Hardcoded setTimeout/setInterval delay - timing-sensitive, may flake under load',
    severity: 'high',
    regex: /\b(setTimeout|setInterval)\s*\(\s*[^,]+,\s*(\d+)\s*\)/g,
    extract: (match) => ({ delay: parseInt(match[2], 10) }),
    filter: (extra) => extra.delay < 5000,
  },
  {
    id: 'process-spawn',
    description: 'Process spawning without guaranteed cleanup - orphaned processes cause port/resource conflicts',
    severity: 'high',
    regex: /\b(execSync|exec|spawn|spawnSync|fork|execFile|execFileSync)\s*\(/g,
  },
  {
    id: 'env-mutation',
    description: 'Direct process.env mutation - leaks state between tests if not restored',
    severity: 'medium',
    regex: /process\.env\.\w+\s*=/g,
  },
  {
    id: 'fixed-port',
    description: 'Hardcoded port number - parallel test runs or leftover processes cause EADDRINUSE',
    severity: 'medium',
    regex: /\.(listen|createServer)\s*\(\s*(\d+)\b/g,
    extract: (match) => ({ port: parseInt(match[2], 10) }),
  },
  {
    id: 'date-now',
    description: 'Date.now() or new Date() without mocking - time-dependent assertions can drift',
    severity: 'low',
    regex: /\b(Date\.now\(\)|new Date\(\))/g,
  },
  {
    id: 'tmp-fixed-path',
    description: 'Fixed temp file path - parallel runs collide; use os.tmpdir() + unique suffix',
    severity: 'medium',
    regex: /['\"`](\/tmp\/[^'\"`]+|\.\/tmp[^'\"`]*)['\"`]/g,
  },
  {
    id: 'shared-mutable-state',
    description: 'Module-level mutable variable used across tests - ordering dependencies',
    severity: 'low',
    regex: /^(let|var)\s+\w+\s*=/gm,
  },
]

function scanFile (filePath) {
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const findings = []

  for (const pattern of PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags)
    let match

    while ((match = regex.exec(content)) !== null) {
      const extra = pattern.extract ? pattern.extract(match) : {}
      if (pattern.filter && !pattern.filter(extra)) continue

      const lineNum = content.substring(0, match.index).split('\n').length
      const lineContent = lines[lineNum - 1]?.trim() || ''

      findings.push({
        pattern: pattern.id,
        severity: pattern.severity,
        description: pattern.description,
        file: filePath,
        line: lineNum,
        match: match[0],
        lineContent,
        ...extra,
      })
    }
  }

  return findings
}

function getTestFiles (dir) {
  const files = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...getTestFiles(full))
    } else if (entry.name.endsWith('.test.js') || entry.name.endsWith('.spec.js')) {
      files.push(full)
    }
  }
  return files
}

const testDir = opts.dir
const testFiles = getTestFiles(testDir)
const allFindings = []

for (const file of testFiles) {
  allFindings.push(...scanFile(file))
}

const severityOrder = { high: 0, medium: 1, low: 2 }
allFindings.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3))

const bySeverity = {
  high: allFindings.filter(f => f.severity === 'high').length,
  medium: allFindings.filter(f => f.severity === 'medium').length,
  low: allFindings.filter(f => f.severity === 'low').length,
}

const byPattern = {}
for (const f of allFindings) {
  byPattern[f.pattern] = (byPattern[f.pattern] || 0) + 1
}

const report = {
  meta: {
    filesScanned: testFiles.length,
    totalFindings: allFindings.length,
    timestamp: new Date().toISOString(),
  },
  summary: {
    bySeverity,
    byPattern,
  },
  findings: allFindings,
}

console.log(JSON.stringify(report, null, 2))
