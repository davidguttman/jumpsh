export const SCHEMA_VERSION = 2;

export const SCHEMA = {
  id:                     { type: 'number',  required: true,  default: null },
  name:                   { type: 'string',  required: true,  default: null },
  path:                   { type: 'string',  required: true,  default: null },
  subdomain:              { type: 'string',  required: true,  default: null },
  description:            { type: 'string',  required: false, default: null },
  parent_project_id:      { type: 'number',  required: false, default: null },
  is_worktree:            { type: 'number',  required: false, default: 0 },
  branch_name:            { type: 'string',  required: false, default: null },
  assigned_port:          { type: 'number',  required: false, default: null },
  override_build_command: { type: 'string',  required: false, default: null },
  override_start_command: { type: 'string',  required: false, default: null },
  override_port:          { type: 'number',  required: false, default: null },
  override_docker_image:  { type: 'string',  required: false, default: null },
  override_env:           { type: 'string',  required: false, default: null },
  desired_running:        { type: 'number',  required: false, default: 0 },
  created_at:             { type: 'string',  required: true,  default: null },
  updated_at:             { type: 'string',  required: true,  default: null },
  schema_version:         { type: 'number',  required: false, default: SCHEMA_VERSION },
};
