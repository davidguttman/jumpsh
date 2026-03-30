import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const HELP = [
  'Usage: jump.sh knowledge-silo [path] [options]',
  '',
  'Analyze git history to detect knowledge silos — files and directories',
  'where only 1-2 contributors have committed changes.',
  '',
  'Arguments:',
  '  path                Project path to analyze (default: current directory)',
  '',
  'Options:',
  '  --threshold <n>     Min contributors before area is NOT a silo (default: 2)',
  '  --depth <n>         Directory grouping depth (default: 2)',
  '  --json              Output as JSON',
  '  --help, -h          Show this help',
].join('\n');

export default async function knowledgeSilo(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  const opts = parseOpts(argv);
  const targetPath = opts.path || process.cwd();

  if (!fs.existsSync(path.join(targetPath, '.git'))) {
    console.error('Not a git repository: ' + targetPath);
    process.exit(1);
  }

  const fileAuthors = getFileAuthors(targetPath);
  if (fileAuthors.size === 0) {
    console.log('No git history found.');
    return;
  }

  const dirStats = groupByDirectory(fileAuthors, opts.depth);
  const siloFiles = getSingleAuthorFiles(fileAuthors);
  const siloReport = buildReport(dirStats, siloFiles, opts.threshold);

  if (opts.json) {
    console.log(JSON.stringify(siloReport, null, 2));
  } else {
    printReport(siloReport);
  }
}

function parseOpts(argv) {
  const opts = { threshold: 2, depth: 2, json: false, path: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--threshold' && argv[i + 1]) {
      opts.threshold = parseInt(argv[++i], 10);
    } else if (argv[i] === '--depth' && argv[i + 1]) {
      opts.depth = parseInt(argv[++i], 10);
    } else if (argv[i] === '--json') {
      opts.json = true;
    } else if (!argv[i].startsWith('-')) {
      opts.path = argv[i];
    }
  }
  return opts;
}

export function getFileAuthors(repoPath) {
  const logWithAuthors = execSync(
    'git log --format="COMMIT_AUTHOR:%aN" --name-only --diff-filter=ACDMR',
    { cwd: repoPath, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );

  return parseGitLog(logWithAuthors);
}

export function parseGitLog(logOutput) {
  const fileAuthors = new Map();
  let currentAuthor = null;

  for (const line of logOutput.split('\n')) {
    if (line.startsWith('COMMIT_AUTHOR:')) {
      currentAuthor = line.slice('COMMIT_AUTHOR:'.length);
    } else if (line.trim() && currentAuthor) {
      const file = line.trim();
      if (!fileAuthors.has(file)) {
        fileAuthors.set(file, new Set());
      }
      fileAuthors.get(file).add(currentAuthor);
    }
  }

  return fileAuthors;
}

export function groupByDirectory(fileAuthors, depth) {
  const dirStats = new Map();

  for (const [file, authors] of fileAuthors) {
    const parts = file.split('/');
    const dirKey = parts.length <= depth
      ? parts.slice(0, -1).join('/') || '.'
      : parts.slice(0, depth).join('/');

    if (!dirStats.has(dirKey)) {
      dirStats.set(dirKey, { authors: new Set(), fileCount: 0, siloFileCount: 0 });
    }
    const stat = dirStats.get(dirKey);
    for (const a of authors) stat.authors.add(a);
    stat.fileCount++;
    if (authors.size <= 1) stat.siloFileCount++;
  }

  return dirStats;
}

export function getSingleAuthorFiles(fileAuthors) {
  const silos = [];
  for (const [file, authors] of fileAuthors) {
    if (authors.size === 1) {
      silos.push({ file, author: [...authors][0] });
    }
  }
  return silos;
}

export function buildReport(dirStats, siloFiles, threshold) {
  const directories = [];
  for (const [dir, stat] of dirStats) {
    const contributorCount = stat.authors.size;
    directories.push({
      directory: dir,
      contributors: contributorCount,
      contributorNames: [...stat.authors].sort(),
      fileCount: stat.fileCount,
      siloFileCount: stat.siloFileCount,
      risk: contributorCount < threshold ? 'high' : contributorCount === threshold ? 'medium' : 'low',
    });
  }

  directories.sort((a, b) => a.contributors - b.contributors || b.siloFileCount - a.siloFileCount);

  return {
    summary: {
      totalDirectories: directories.length,
      highRisk: directories.filter(d => d.risk === 'high').length,
      mediumRisk: directories.filter(d => d.risk === 'medium').length,
      totalSingleAuthorFiles: siloFiles.length,
    },
    directories,
    singleAuthorFiles: siloFiles.slice(0, 30),
  };
}

export function printReport(report) {
  const { summary, directories, singleAuthorFiles } = report;

  console.log('=== Knowledge Silo Report ===\n');
  console.log('Directories analyzed: ' + summary.totalDirectories);
  console.log('High risk (single contributor): ' + summary.highRisk);
  console.log('Medium risk: ' + summary.mediumRisk);
  console.log('Single-author files: ' + summary.totalSingleAuthorFiles + '\n');

  console.log('--- Directory Risk ---\n');

  const nameW = Math.max(9, ...directories.map(d => d.directory.length));
  console.log(
    'DIRECTORY'.padEnd(nameW) + '  ' +
    'CONTRIBS'.padEnd(8) + '  ' +
    'FILES'.padEnd(5) + '  ' +
    'SILO FILES'.padEnd(10) + '  ' +
    'RISK'
  );

  for (const d of directories) {
    const riskLabel = d.risk === 'high' ? '\u26A0 HIGH' : d.risk === 'medium' ? '~ MED' : '  low';
    console.log(
      d.directory.padEnd(nameW) + '  ' +
      String(d.contributors).padEnd(8) + '  ' +
      String(d.fileCount).padEnd(5) + '  ' +
      String(d.siloFileCount).padEnd(10) + '  ' +
      riskLabel
    );
  }

  if (singleAuthorFiles.length > 0) {
    console.log('\n--- Single-Author Files (top 30) ---\n');
    for (const f of singleAuthorFiles) {
      console.log('  ' + f.file + '  (' + f.author + ')');
    }
  }

  console.log('\n--- Suggestions ---\n');
  const highRiskDirs = directories.filter(d => d.risk === 'high');
  if (highRiskDirs.length > 0) {
    console.log('Consider pair programming or code review in these areas:');
    for (const d of highRiskDirs) {
      console.log('  \u2022 ' + d.directory + ' \u2014 only ' + d.contributorNames.join(', '));
    }
  } else {
    console.log('No high-risk silos detected. Knowledge is well-distributed!');
  }
}
