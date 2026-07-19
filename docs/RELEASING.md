# Releasing

Public artifacts are:

- `@kiri_ikki/thread-contracts`
- `@kiri_ikki/thread-client`
- `@kiri_ikki/thread-react`
- `@kiri_ikki/thread-agent-check`
- `ghcr.io/hieuej147/copilotkit-threads-runtime`

## Release flow

The public package manifests intentionally start at `0.0.0`. The checked-in
initial changesets turn all four packages into `0.1.0` in the first version PR;
do not edit those versions by hand.

1. Add a changeset with `pnpm changeset` in each behavior-changing pull request.
2. Merge to `main`. `release-pr.yml` maintains a version pull request.
3. Merge the version pull request after CI passes.
4. Tag the resulting commit, for example `git tag v0.1.0`, then push the tag.
5. `release.yml` tests and publishes npm packages, then builds amd64/arm64 GHCR
   images tagged `0.1.0`, `0.1`, commit SHA and `latest`.

Package versions in the release commit must match the Git tag. Do not reuse or
move a published tag.

## Bootstrap npm authentication

The first publication needs a granular npm automation token because npm cannot
configure a trusted publisher for a package that does not exist yet. Store it as
the repository Actions secret `NPM_TOKEN`; never put it in `.npmrc` or source.

After the first successful publication, configure Trusted Publisher for every
package on npm:

```text
Provider: GitHub Actions
User or organization: Hieuej147
Repository: Copilotkit-threads
Workflow filename: release.yml
Allowed action: npm publish
```

The workflow already grants `id-token: write` and uses Node 22.14 plus npm
11.5.1 or newer. After one successful OIDC publication, remove the `NPM_TOKEN`
secret and revoke the token on npm. Public packages from this public repository
receive npm provenance automatically.

After the first GHCR push, set the Runtime package visibility to Public in the
GitHub package settings so fresh clones can pull without registry credentials.
