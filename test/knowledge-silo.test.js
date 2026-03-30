import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitLog,
  groupByDirectory,
  getSingleAuthorFiles,
  buildReport,
} from '../lib/commands/knowledge-silo.js';

describe('knowledge-silo', () => {
  describe('parseGitLog', () => {
    it('parses commit authors and files', () => {
      const log = [
        'COMMIT_AUTHOR:Alice',
        '',
        'src/foo.js',
        'src/bar.js',
        '',
        'COMMIT_AUTHOR:Bob',
        '',
        'src/foo.js',
        'lib/util.js',
      ].join('\n');

      const result = parseGitLog(log);
      assert.equal(result.size, 3);
      assert.deepEqual([...result.get('src/foo.js')].sort(), ['Alice', 'Bob']);
      assert.deepEqual([...result.get('src/bar.js')], ['Alice']);
      assert.deepEqual([...result.get('lib/util.js')], ['Bob']);
    });

    it('returns empty map for empty input', () => {
      const result = parseGitLog('');
      assert.equal(result.size, 0);
    });

    it('handles single author with multiple commits', () => {
      const log = [
        'COMMIT_AUTHOR:Alice',
        '',
        'a.js',
        '',
        'COMMIT_AUTHOR:Alice',
        '',
        'b.js',
      ].join('\n');

      const result = parseGitLog(log);
      assert.deepEqual([...result.get('a.js')], ['Alice']);
      assert.deepEqual([...result.get('b.js')], ['Alice']);
    });
  });

  describe('groupByDirectory', () => {
    it('groups files by directory at given depth', () => {
      const fileAuthors = new Map([
        ['src/components/Button.js', new Set(['Alice'])],
        ['src/components/Input.js', new Set(['Alice', 'Bob'])],
        ['src/utils/helpers.js', new Set(['Bob'])],
        ['README.md', new Set(['Alice'])],
      ]);

      const result = groupByDirectory(fileAuthors, 2);

      assert.equal(result.get('src/components').fileCount, 2);
      assert.equal(result.get('src/utils').fileCount, 1);
      assert.equal(result.get('.').fileCount, 1);
    });

    it('counts silo files correctly', () => {
      const fileAuthors = new Map([
        ['lib/a.js', new Set(['Alice'])],
        ['lib/b.js', new Set(['Alice', 'Bob'])],
        ['lib/c.js', new Set(['Charlie'])],
      ]);

      const result = groupByDirectory(fileAuthors, 2);
      assert.equal(result.get('lib').siloFileCount, 2);
    });
  });

  describe('getSingleAuthorFiles', () => {
    it('returns only single-author files', () => {
      const fileAuthors = new Map([
        ['a.js', new Set(['Alice'])],
        ['b.js', new Set(['Alice', 'Bob'])],
        ['c.js', new Set(['Charlie'])],
      ]);

      const silos = getSingleAuthorFiles(fileAuthors);
      assert.equal(silos.length, 2);
      assert.equal(silos[0].file, 'a.js');
      assert.equal(silos[0].author, 'Alice');
      assert.equal(silos[1].file, 'c.js');
      assert.equal(silos[1].author, 'Charlie');
    });

    it('returns empty array when all files have multiple authors', () => {
      const fileAuthors = new Map([
        ['a.js', new Set(['Alice', 'Bob'])],
      ]);
      assert.equal(getSingleAuthorFiles(fileAuthors).length, 0);
    });
  });

  describe('buildReport', () => {
    it('classifies risk correctly', () => {
      const dirStats = new Map([
        ['solo', { authors: new Set(['Alice']), fileCount: 5, siloFileCount: 5 }],
        ['pair', { authors: new Set(['Alice', 'Bob']), fileCount: 3, siloFileCount: 1 }],
        ['team', { authors: new Set(['Alice', 'Bob', 'Charlie']), fileCount: 4, siloFileCount: 0 }],
      ]);

      const report = buildReport(dirStats, [], 2);

      const solo = report.directories.find(d => d.directory === 'solo');
      const pair = report.directories.find(d => d.directory === 'pair');
      const team = report.directories.find(d => d.directory === 'team');

      assert.equal(solo.risk, 'high');
      assert.equal(pair.risk, 'medium');
      assert.equal(team.risk, 'low');
    });

    it('sorts by contributor count ascending', () => {
      const dirStats = new Map([
        ['many', { authors: new Set(['A', 'B', 'C']), fileCount: 1, siloFileCount: 0 }],
        ['few', { authors: new Set(['A']), fileCount: 1, siloFileCount: 1 }],
      ]);

      const report = buildReport(dirStats, [], 2);
      assert.equal(report.directories[0].directory, 'few');
      assert.equal(report.directories[1].directory, 'many');
    });

    it('includes summary counts', () => {
      const dirStats = new Map([
        ['a', { authors: new Set(['X']), fileCount: 2, siloFileCount: 2 }],
        ['b', { authors: new Set(['X', 'Y']), fileCount: 3, siloFileCount: 1 }],
      ]);
      const siloFiles = [{ file: 'x', author: 'X' }, { file: 'y', author: 'X' }];

      const report = buildReport(dirStats, siloFiles, 2);
      assert.equal(report.summary.totalDirectories, 2);
      assert.equal(report.summary.highRisk, 1);
      assert.equal(report.summary.mediumRisk, 1);
      assert.equal(report.summary.totalSingleAuthorFiles, 2);
    });
  });
});
