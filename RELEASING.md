# Release procedure

## Required gates

The `Release gates` workflow runs on pull requests, main/master pushes, version tags and manual dispatch. Require every job in branch protection before merging. Repository administration must enable GitHub private vulnerability reporting and mark the published package public if public container pulls are intended.

- Node 22 and 24 on Linux, Node 22 on Windows: typecheck, lint, application/security/recovery/upgrade tests, production dependency audit, build and browser smoke.
- Real Postgres 17 and 18: concurrent migrations, transaction isolation, quota enforcement and rollback. The Postgres 17 service gate also verifies pg_dump/pg_restore. Set PG_BIN to a directory containing matching pg_dump/pg_restore tools to run that check against the local Postgres 18 harness.
- Real boto3, AWS CLI and rclone: signing, objects, ranges, listing/pagination, copy, tags, presigned URLs and multipart.
- Linux amd64 and arm64: build and run the non-root Docker image, check health, sessions after abrupt termination and graceful shutdown. An amd64 validation image also exercises a full-filesystem failure on a disposable tmpfs.

A tag beginning with `v` publishes a multi-architecture image to `ghcr.io/<owner>/<repository>` only after all of the above jobs pass. Publication includes provenance and SBOM attestations. The release job also publishes checksummed amd64/arm64 `docker load` archives as public GitHub release assets; these provide anonymous downloads independently of the GHCR package visibility setting. Published release archives are not overwritten by a rerun. The workflow does not change DNS, provision a server, or start production containers.

Never waive a failed container, data-recovery or security gate. Passing local Node tests is insufficient evidence that the container gates passed. This repository does not claim that the Docker gates ran merely because their definitions exist.

## Local checks

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm audit --omit=dev --audit-level=low
npm run build
npx playwright install chromium
npm run test:selfhost
npm run test:postgres
python -m venv .venv
# Activate .venv using the command for your shell.
python -m pip install -r requirements-test.txt
# Install rclone from your OS package manager or a verified official binary.
npm run test:clients
npm run test:docker
```

`test:postgres` creates a disposable real cluster when TEST_DATABASE_URL is absent. It never needs an existing production database. Set TEST_DATABASE_URL only to an empty disposable database. `test:clients` requires Python with requirements-test.txt and rclone on PATH (or RCLONE_BIN). Set PYTHON when the executable is not named `python`. PLAYWRIGHT_CHANNEL selects an installed browser if Chromium is not installed.

## Deploy

1. Choose a release tag only after the required gates are green, and retain a verified backup before upgrading.
2. Set BETTER_AUTH_URL to the exact public HTTPS origin. Keep registration disabled except while deliberately creating accounts.
3. Use the documented Caddy overlay or your own HTTPS proxy. Persist DATA_DIR or use external Postgres with a retained BETTER_AUTH_SECRET.
4. Deploy the exact image digest emitted by the tag workflow; retain the previous digest and backup. Check health, sign-in, a private upload/download, a public download and access-key restrictions on the actual hostname.
5. Restore-test backups regularly on a separate node. Do not merge a restored database into a live DATA_DIR.

Database migrations are forward-only. Rolling back an image is safe only when its schema expectations are compatible; otherwise stop the node and restore the matching pre-upgrade backup. Do not change signing secrets during a routine upgrade.

## Dependency triage

Production dependencies must have zero reported audit findings. Development-only minimatch advisories currently propagate through ESLint tooling; upstream does not offer a compatible automatic fix. These tools process repository-controlled paths in CI and are removed from the runtime image by `npm prune --omit=dev`. Recheck this assessment on every dependency update. Do not suppress the production audit or force incompatible dependency overrides to make the report green.

## Verify published images

After the image is published, dispatch Release gates with `verify_version` set to its numeric version (for example `0.2.0`). The dedicated jobs pull anonymously from the registry on native amd64/arm64 runners, then test initial admin login, protected metrics, session persistence after a crash, graceful shutdown and the shipped password-recovery command. They do not rebuild the image. Retain these results with the release evidence.
