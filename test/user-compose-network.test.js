import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import DockerManager, { canReuseDefaultBridge } from '../services/DockerManager.js';
import { makeTmpDir, cleanTmpDir } from './helpers/fixtures.js';

// User-provided compose files with only Compose's implicit per-project default
// network would allocate a subnet per preview and exhaust Docker's address
// pools. Jump's runtime override reuses the shared default bridge only for the
// narrow case where that cannot change behavior the user asked for.

function hasDockerCompose() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const dockerComposeAvailable = hasDockerCompose();

// Mirrors david.app's gameboy-link compose file.
const GAMEBOY_LINK = `services:
  app:
    image: nginxinc/nginx-unprivileged:1.28-alpine
    expose:
      - "8080"
    volumes:
      - ./public:/usr/share/nginx/html:ro
    restart: unless-stopped
`;

// Shape of `docker compose config --format json` for GAMEBOY_LINK.
function implicitDefaultConfig() {
  return {
    name: 'gameboy-link',
    services: {
      app: {
        image: 'nginxinc/nginx-unprivileged:1.28-alpine',
        expose: ['8080'],
        networks: { default: null },
        restart: 'unless-stopped',
      },
    },
    networks: { default: { name: 'gameboy-link_default', ipam: {} } },
  };
}

const INELIGIBLE = {
  'explicit default network list': `services:
  app:
    image: nginx:alpine
    expose: ["8080"]
    networks:
      - default
`,
  'explicit default network map': `services:
  app:
    image: nginx:alpine
    expose: ["8080"]
    networks:
      default: {}
`,
  'customized top-level default network': `services:
  app:
    image: nginx:alpine
    expose: ["8080"]
networks:
  default:
    driver: bridge
`,
  'custom network': `services:
  app:
    image: nginx:alpine
    expose: ["8080"]
    networks: [backend]
networks:
  backend: {}
`,
  'custom network_mode': `services:
  app:
    image: nginx:alpine
    expose: ["8080"]
    network_mode: host
`,
  'multi-service implicit default': `services:
  app:
    image: nginx:alpine
    expose: ["8080"]
  db:
    image: redis:alpine
`,
  'flow-style networks key': `services:
  app: {image: nginx:alpine, expose: ["8080"], networks: [default]}
`,
  'Unicode-escaped networks key': String.raw`services:
  app: {image: nginx:alpine, expose: ["8080"], "\u006eetworks": [default]}
`,
  'hex-escaped networks key': String.raw`services:
  app: {image: nginx:alpine, expose: ["8080"], "\x6eetworks": [default]}
`,
  'long-Unicode-escaped networks key': String.raw`services:
  app: {image: nginx:alpine, expose: ["8080"], "\U0000006eetworks": [default]}
`,
  'backslash outside networking': String.raw`services:
  app: {image: nginx:alpine, expose: ["8080"], command: "echo \\n"}
`,
  'aliased networks key': `x-key: &network-key networks
services:
  app:
    image: nginx:alpine
    expose: ["8080"]
    *network-key : [default]
`,
  'anchored service': `services:
  app: &app {image: nginx:alpine, expose: ["8080"]}
`,
  'tagged service': `services:
  app: !!map {image: nginx:alpine, expose: ["8080"]}
`,
  'asterisk outside networking': `services:
  app: {image: nginx:alpine, expose: ["8080"], command: "echo *"}
`,
  'extends': `services:
  app:
    extends:
      file: base.yml
      service: web
    expose: ["8080"]
`,
  'include': `include:
  - other.yml
services:
  app:
    image: nginx:alpine
    expose: ["8080"]
`,
  'profiles': `services:
  app:
    image: nginx:alpine
    expose: ["8080"]
  worker:
    image: redis:alpine
    profiles: [jobs]
`,
  'links': `services:
  app:
    image: nginx:alpine
    expose: ["8080"]
    external_links:
      - other_db:db
`,
};

describe('canReuseDefaultBridge', () => {
  it('allows a single service with only implicit default networking', () => {
    assert.equal(canReuseDefaultBridge({ composeText: GAMEBOY_LINK, config: implicitDefaultConfig(), serviceName: 'app' }), true);
  });

  it('allows resolved configs that omit the default network entirely', () => {
    const config = implicitDefaultConfig();
    delete config.services.app.networks;
    delete config.networks;
    assert.equal(canReuseDefaultBridge({ composeText: GAMEBOY_LINK, config, serviceName: 'app' }), true);
  });

  for (const [label, composeText] of Object.entries(INELIGIBLE)) {
    // Extra services are detected from the resolved config (tested below).
    if (label === 'multi-service implicit default') continue;
    it(`rejects ${label} in the user compose text`, () => {
      assert.equal(canReuseDefaultBridge({ composeText, config: implicitDefaultConfig(), serviceName: 'app' }), false);
    });
  }

  it('rejects when the resolved config is unavailable', () => {
    assert.equal(canReuseDefaultBridge({ composeText: GAMEBOY_LINK, config: null, serviceName: 'app' }), false);
  });

  it('rejects resolved multi-service configs', () => {
    const config = implicitDefaultConfig();
    config.services.db = { image: 'redis:alpine', networks: { default: null } };
    assert.equal(canReuseDefaultBridge({ composeText: GAMEBOY_LINK, config, serviceName: 'app' }), false);
  });

  it('rejects resolved network_mode, aliases, or extra networks', () => {
    const variants = [
      c => { c.services.app.network_mode = 'host'; delete c.services.app.networks; },
      c => { c.services.app.networks = { default: { aliases: ['web'] } }; },
      c => { c.services.app.networks = { default: null, other: null }; c.networks.other = { name: 'x' }; },
      c => { c.networks.default.driver = 'macvlan'; },
      c => { c.networks.default.external = true; },
      c => { c.networks.default.ipam = { config: [{ subnet: '10.9.0.0/24' }] }; },
    ];
    for (const mutate of variants) {
      const config = implicitDefaultConfig();
      mutate(config);
      assert.equal(canReuseDefaultBridge({ composeText: GAMEBOY_LINK, config, serviceName: 'app' }), false, JSON.stringify(config));
    }
  });
});

describe('_prepareUserComposeRuntime network reuse', () => {
  let home, oldHome, projectDir, composePath;

  beforeEach(() => {
    oldHome = process.env.HOME;
    home = makeTmpDir();
    process.env.HOME = home;
    projectDir = makeTmpDir();
    fs.mkdirSync(path.join(projectDir, 'public'));
    composePath = path.join(projectDir, 'docker-compose.yml');
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    cleanTmpDir(home);
    cleanTmpDir(projectDir);
  });

  function worktreeProject() {
    return { id: 7, name: 'gameboy-link', subdomain: 'gameboy-link--feature', path: projectDir, is_worktree: 1, assigned_port: 10077 };
  }

  function stubbedManager(config) {
    const docker = new DockerManager(null);
    docker._selectComposeService = async () => 'app';
    docker._inspectComposeService = async () => ({ found: true, hasPublishedPorts: false, internalPort: 8080, config });
    return docker;
  }

  it('reuses the shared bridge for the gameboy-link shape without editing user compose', async () => {
    fs.writeFileSync(composePath, GAMEBOY_LINK);
    const result = await stubbedManager(implicitDefaultConfig())._prepareUserComposeRuntime(worktreeProject(), composePath, null);

    assert.equal(fs.readFileSync(composePath, 'utf8'), GAMEBOY_LINK);
    const override = fs.readFileSync(result.composePath[1], 'utf8');
    assert.match(override, /\n {2}app:\n {4}network_mode: bridge\n/u);
    assert.match(override, /host_ip: 127\.0\.0\.1/u);
    assert.doesNotMatch(override, /networks:/u);
  });

  it('leaves networking alone when the user names the default network explicitly', async () => {
    fs.writeFileSync(composePath, INELIGIBLE['explicit default network list']);
    const result = await stubbedManager(implicitDefaultConfig())._prepareUserComposeRuntime(worktreeProject(), composePath, null);

    const override = fs.readFileSync(result.composePath[1], 'utf8');
    assert.doesNotMatch(override, /network_mode|networks:/u);
  });

  for (const label of ['Unicode-escaped networks key', 'aliased networks key']) {
    it(`preserves ${label} without editing user compose`, async () => {
      const composeText = INELIGIBLE[label];
      fs.writeFileSync(composePath, composeText);
      const result = await stubbedManager(implicitDefaultConfig())._prepareUserComposeRuntime(worktreeProject(), composePath, null);

      assert.equal(fs.readFileSync(composePath, 'utf8'), composeText);
      const override = fs.readFileSync(result.composePath[1], 'utf8');
      assert.doesNotMatch(override, /network_mode|networks:/u);
    });
  }

  describe('with real compose resolution', { skip: !dockerComposeAvailable }, () => {
    function resolvedRuntime(paths) {
      const args = ['compose', '--project-name', `jump-sh-netreuse-${process.pid}`];
      for (const p of paths) args.push('-f', p);
      args.push('config', '--format', 'json');
      return JSON.parse(execFileSync('docker', args, { cwd: projectDir, encoding: 'utf8' }));
    }

    it('resolves the gameboy-link preview onto the shared bridge with no project network', async () => {
      fs.writeFileSync(composePath, GAMEBOY_LINK);
      const docker = new DockerManager(null);
      const result = await docker._prepareUserComposeRuntime(worktreeProject(), composePath, null);
      assert.ok(Array.isArray(result.composePath));

      const config = resolvedRuntime(result.composePath);
      assert.equal(config.services.app.network_mode, 'bridge');
      assert.equal(config.services.app.networks, undefined);
      assert.deepEqual(config.networks ?? {}, {});
    });

    for (const label of ['explicit default network list', 'Unicode-escaped networks key', 'aliased networks key', 'custom network', 'custom network_mode', 'multi-service implicit default']) {
      it(`keeps user networking for ${label}`, async () => {
        fs.writeFileSync(composePath, INELIGIBLE[label]);
        const docker = new DockerManager(null);
        const result = await docker._prepareUserComposeRuntime(worktreeProject(), composePath, null);
        const override = fs.readFileSync(result.composePath[1], 'utf8');
        assert.doesNotMatch(override, /network_mode|networks:/u);
      });
    }
  });
});
