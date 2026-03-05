export const PROJECT_FIELDS = {
  name: {
    required: true,
    type: 'string',
    description: 'Project name (used for subdomain)',
    cliFlag: '--name, -n',
  },
  path: {
    required: true,
    type: 'string',
    description: 'Absolute path to project directory',
  },
  override_build_command: {
    required: false,
    type: 'string',
    description: 'Build/install command (e.g., "npm install")',
    cliFlag: '--build',
  },
  override_start_command: {
    required: false,
    type: 'string',
    description: 'Start/dev command (e.g., "npm run dev")',
    cliFlag: '--start',
  },
  override_port: {
    required: false,
    type: 'number',
    description: 'Port the dev server listens on',
    cliFlag: '--port, -p',
  },
  override_docker_image: {
    required: false,
    type: 'string',
    description: 'Docker image (e.g., "node:20-slim")',
    cliFlag: '--image',
  },
  override_env: {
    required: false,
    type: 'array',
    items: { key: 'string', value: 'string' },
    description: 'Environment variable overrides',
    cliFlag: '--env, -e (repeatable)',
  },
};
