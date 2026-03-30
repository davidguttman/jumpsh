import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA, SCHEMA_VERSION } from '../lib/schema-definition.js';
import { checkDrift, migrateRecord, migrateAll } from '../lib/schema-migrator.js';

function makeFullRecord() {
  return {
    id: 1,
    name: 'test-project',
    path: '/tmp/test',
    subdomain: 'test-project',
    description: null,
    parent_project_id: null,
    is_worktree: 0,
    branch_name: null,
    assigned_port: null,
    override_build_command: null,
    override_start_command: null,
    override_port: null,
    override_docker_image: null,
    override_env: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

describe('schema-definition', () => {
  it('exports a version number', () => {
    assert.equal(typeof SCHEMA_VERSION, 'number');
    assert.ok(SCHEMA_VERSION >= 1);
  });

  it('defines all expected fields', () => {
    const expected = [
      'id', 'name', 'path', 'subdomain', 'description',
      'parent_project_id', 'is_worktree', 'branch_name',
      'assigned_port', 'override_build_command', 'override_start_command',
      'override_port', 'override_docker_image', 'override_env',
      'created_at', 'updated_at', 'schema_version',
    ];
    assert.deepEqual(Object.keys(SCHEMA), expected);
  });
});

describe('checkDrift', () => {
  it('returns no issues for a complete record', () => {
    const issues = checkDrift(makeFullRecord());
    assert.equal(issues.length, 0);
  });

  it('detects missing fields', () => {
    const record = { id: 1, name: 'x' };
    const issues = checkDrift(record);
    const missing = issues.filter(i => i.issue === 'missing');
    assert.ok(missing.length > 0);
    assert.ok(missing.some(i => i.field === 'path'));
  });

  it('detects unknown fields', () => {
    const record = { ...makeFullRecord(), bogus_field: 'wat' };
    const issues = checkDrift(record);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].issue, 'unknown');
    assert.equal(issues[0].field, 'bogus_field');
  });

  it('detects type mismatches', () => {
    const record = { ...makeFullRecord(), id: 'not-a-number' };
    const issues = checkDrift(record);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].issue, 'type_mismatch');
    assert.equal(issues[0].field, 'id');
  });

  it('allows null values regardless of type', () => {
    const record = { ...makeFullRecord(), description: null };
    const issues = checkDrift(record);
    assert.equal(issues.length, 0);
  });
});

describe('migrateRecord', () => {
  it('adds missing fields with defaults', () => {
    const record = { id: 1, name: 'x', path: '/tmp', subdomain: 'x', created_at: 'now', updated_at: 'now' };
    const migrated = migrateRecord(record);
    assert.equal(migrated.is_worktree, 0);
    assert.equal(migrated.description, null);
    assert.equal(migrated.schema_version, SCHEMA_VERSION);
  });

  it('does not overwrite existing fields', () => {
    const record = makeFullRecord();
    record.description = 'my desc';
    const migrated = migrateRecord(record);
    assert.equal(migrated.description, 'my desc');
  });

  it('stamps schema_version', () => {
    const record = makeFullRecord();
    delete record.schema_version;
    const migrated = migrateRecord(record);
    assert.equal(migrated.schema_version, SCHEMA_VERSION);
  });

  it('is idempotent on an already-current record', () => {
    const record = makeFullRecord();
    const migrated = migrateRecord(record);
    assert.deepEqual(migrated, record);
  });
});

describe('migrateAll', () => {
  it('migrates an array of records', () => {
    const records = [
      { id: 1, name: 'a', path: '/a', subdomain: 'a', created_at: 'now', updated_at: 'now' },
      { id: 2, name: 'b', path: '/b', subdomain: 'b', created_at: 'now', updated_at: 'now' },
    ];
    const migrated = migrateAll(records);
    assert.equal(migrated.length, 2);
    assert.equal(migrated[0].schema_version, SCHEMA_VERSION);
    assert.equal(migrated[1].schema_version, SCHEMA_VERSION);
    assert.equal(migrated[0].is_worktree, 0);
  });
});
