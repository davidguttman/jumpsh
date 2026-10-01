# Releases

jump.sh follows Semantic Versioning. Breaking management API, authentication, configuration, or lifecycle behavior requires a major release; backward-compatible capabilities require a minor release; fixes without new capabilities use a patch release.

Use `npm version <major|minor|patch> --no-git-tag-version` to update package.json and package-lock.json. Verify tests, lint, syntax and package contents after versioning. Commit the version, tag it `v<version>`, push the release commit/tag, create a GitHub release with migration notes, and publish the npm package. Verify the registry version and intended dist-tag after publishing.

## 1.0.0 migration

Management endpoints now require authentication. Install/start creates a per-install token at ~/.jump.sh/management-token; CLI daemon calls authenticate automatically. Browsers sign in on the `/login` page by pasting the token (no Basic-auth popup; Basic credentials are not accepted) and receive a host-only `HttpOnly` session cookie. Use HTTPS. Existing browser sessions must sign in again.

Only the configured dashboard hostname reaches management. Incoming X-Forwarded-Host is ignored. Running project applications remain accessible; visiting a stopped project no longer starts it. New jump-owned container port mappings use loopback; user-owned Compose mappings are not rewritten. Existing containers/mappings must not be assumed migrated merely by upgrading the npm package.
