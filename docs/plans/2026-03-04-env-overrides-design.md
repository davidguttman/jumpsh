# Environment Variable Overrides

## Overview

Add ability to override individual environment variables on a per-project basis via the dashboard UI.

## Behavior

- User-specified env vars override individual vars from the project's `.env` file
- They do NOT replace the entire `.env` file — just override specific keys
- Docker Compose `environment:` section takes precedence over `env_file:`, so user overrides win

## Database

Add `override_env` field to project records:

```javascript
// In database.js createProject and upsertWorktree
override_env: project.override_env || null,  // JSON string: [{"key":"VAR","value":"val"},...]
```

## UI

### Key-Value Pair Inputs

Both `add.ejs` and `project.ejs` get a new "Environment Overrides" section:

```
Environment Overrides
┌─────────────┐  ┌─────────────┐  ┌───┐
│ API_KEY     │  │ secret123   │  │ ✕ │
└─────────────┘  └─────────────┘  └───┘
┌─────────────┐  ┌─────────────┐  ┌───┐
│ DEBUG       │  │ true        │  │ ✕ │
└─────────────┘  └─────────────┘  └───┘
         [+ Add Variable]
```

- Each row: key input, value input, remove button
- "+ Add Variable" button adds a new empty row
- Empty rows are filtered out on submit
- Style to match existing form inputs

### add.ejs

Add the env vars section after the Docker Image field:

```html
<div class="form-group">
  <label class="label">Environment Overrides</label>
  <div id="env-vars-container"></div>
  <button type="button" class="btn btn-sm" id="add-env-var">+ Add Variable</button>
  <input type="hidden" id="override_env" name="override_env">
</div>
```

JavaScript:
- Manage an array of {key, value} objects
- Render rows dynamically
- On form submit, serialize to JSON in hidden input

### project.ejs

Add to the settings panel after Docker Image:

```html
<div class="form-group">
  <label class="label">Environment Overrides</label>
  <div id="env-vars-container"></div>
  <button type="button" class="btn btn-sm" id="add-env-var">+ Add Variable</button>
</div>
```

- Load existing values from `project.override_env` (parse JSON)
- Include in saveSettings() PATCH request

## API

### POST /projects

Already accepts body fields. Add `override_env` to the creation:

```javascript
override_env: req.body.override_env || null,  // JSON string
```

### PATCH /api/projects/:id

Add `override_env` to allowed fields:

```javascript
const allowed = ['override_build_command', 'override_start_command', 'override_port', 'override_docker_image', 'override_env'];
```

## ComposeGenerator

In `generateComposeYaml()`, after the auto-detected env vars, add user overrides:

```javascript
// Add user override env vars (these take precedence)
if (opts.overrides?.env) {
  try {
    const userEnvVars = JSON.parse(opts.overrides.env);
    for (const { key, value } of userEnvVars) {
      if (key && value !== undefined) {
        envVars.push(`      - ${key}=${value}`);
      }
    }
  } catch { /* ignore invalid JSON */ }
}
```

Pass from DockerManager.start():

```javascript
const overrides = {
  build: project.override_build_command,
  start: project.override_start_command,
  port: project.override_port,
  dockerImage: project.override_docker_image,
  env: project.override_env,  // Add this
};
```

## Files to Modify

1. `database.js` - Add override_env field to createProject and upsertWorktree
2. `server.js` - Accept override_env in POST /projects and PATCH /api/projects/:id
3. `views/add.ejs` - Add env vars UI section
4. `views/project.ejs` - Add env vars to settings panel
5. `services/ComposeGenerator.js` - Include user env vars in environment: block
6. `services/DockerManager.js` - Pass override_env to generateCompose

## Testing

1. Add a new project with env overrides → verify they appear in generated docker-compose.yml
2. Edit env overrides on existing project → save and restart → verify changes applied
3. Empty/invalid env vars should be filtered out
4. Existing projects without env overrides should continue working (null/undefined handling)
