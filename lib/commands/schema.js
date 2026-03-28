import { parseArgs } from 'node:util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SCHEMA_VERSION } from '../schema-definition.js';
import { checkDrift, migrateAll } from '../schema-migrator.js';

const DB_PATH = path.join(os.homedir(), '.jump.sh', 'projects.json');

const HELP = `
jump.sh schema — check and migrate project database schema

Usage: jump.sh schema <subcommand>

Subcommands:
  check       Report drift between projects.json and the canonical schema
  migrate     Add missing fields with defaults, stamp schema_version

Options:
  --help, -h  Show this help
  --json      Output results as JSON (check only)
`.trim();

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('No projects.json found at ' + DB_PATH);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2) + '\n');
}

function runCheck(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
    strict: false,
  });

  const data = loadDb();
  const projects = data.projects || [];

  if (projects.length === 0) {
    console.log('No projects found.');
    process.exit(0);
  }

  let totalIssues = 0;
  const results = [];

  for (const project of projects) {
    const issues = checkDrift(project);
    if (issues.length > 0) {
      totalIssues += issues.length;
      results.push({ id: project.id, name: project.name || '(unnamed)', issues });
    }
  }

  if (values.json) {
    console.log(JSON.stringify({ schema_version: SCHEMA_VERSION, total_issues: totalIssues, projects: results }, null, 2));
    process.exit(totalIssues > 0 ? 1 : 0);
  }

  if (totalIssues === 0) {
    console.log(`All ${projects.length} project(s) match schema version ${SCHEMA_VERSION}. No drift detected.`);
    process.exit(0);
  }

  console.log(`Schema version: ${SCHEMA_VERSION}`);
  console.log(`Found ${totalIssues} issue(s) across ${results.length} project(s):\n`);

  for (const r of results) {
    console.log(`  Project #${r.id} (${r.name}):`);
    for (const issue of r.issues) {
      console.log(`    - ${issue.message}`);
    }
    console.log();
  }

  console.log('Run "jump.sh schema migrate" to fix missing fields.');
  process.exit(1);
}

function runMigrate() {
  const data = loadDb();
  const projects = data.projects || [];

  if (projects.length === 0) {
    console.log('No projects to migrate.');
    process.exit(0);
  }

  const migrated = migrateAll(projects);
  data.projects = migrated;
  saveDb(data);

  console.log(`Migrated ${migrated.length} project(s) to schema version ${SCHEMA_VERSION}.`);
  process.exit(0);
}

export default async function schema(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  const subcommand = argv[0];

  if (subcommand === 'check') {
    runCheck(argv.slice(1));
  } else if (subcommand === 'migrate') {
    runMigrate();
  } else {
    console.error(subcommand ? `Unknown schema subcommand: ${subcommand}` : 'Usage: jump.sh schema <check|migrate>');
    console.error('Run "jump.sh schema --help" for usage.');
    process.exit(2);
  }
}
