import { SCHEMA, SCHEMA_VERSION } from './schema-definition.js';

export function checkDrift(record) {
  const issues = [];
  const schemaFields = Object.keys(SCHEMA);

  for (const field of schemaFields) {
    const spec = SCHEMA[field];
    if (!(field in record)) {
      issues.push({ field, issue: 'missing', message: `Missing field: ${field}` });
      continue;
    }
    const value = record[field];
    if (value !== null && typeof value !== spec.type) {
      issues.push({
        field,
        issue: 'type_mismatch',
        message: `Type mismatch on "${field}": expected ${spec.type}, got ${typeof value}`,
      });
    }
  }

  for (const field of Object.keys(record)) {
    if (!SCHEMA[field]) {
      issues.push({ field, issue: 'unknown', message: `Unknown field: ${field}` });
    }
  }

  return issues;
}

export function migrateRecord(record) {
  const migrated = { ...record };

  for (const [field, spec] of Object.entries(SCHEMA)) {
    if (!(field in migrated)) {
      migrated[field] = spec.default;
    }
  }

  migrated.schema_version = SCHEMA_VERSION;
  return migrated;
}

export function migrateAll(projects) {
  return projects.map(migrateRecord);
}
