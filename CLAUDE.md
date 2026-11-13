# Docker NetMan — CLAUDE.md

Concise design record, not a diary. Built end to end from `docs/SPEC.md` (kept in the repo for
reference — read it first for full rationale; this file condenses it plus what building it
actually confirmed).

## Name

This project was briefly named **unraid-multinet** (`MultiNet.page`, `window.multinet`, etc.)
before being renamed to **Docker NetMan** at 0.3.0 to avoid colliding with an existing CA
plugin, "Docker Networks" by mstrhakr — noted here only so old commit messages and any stray
`multinet_`/`MultiNet` reference someone stumbles on make sense; the old repo no longer exists,
and everything below uses the current names throughout, including in descriptions of things
that happened before the rename.

## What this project is

Unraid's dockerMan gives a container exactly one network. This plugin adds more, persisted in
the container's own template XML (dockerMan's own `xmlToCommand()` re-applies it on every
reinstall/force-update/"Previous Apps" — no runtime hook, no plugin database).

## Serialization design

- **Primary is a user-defined network** (custom bridge, `br0`/`br0.66`, ipvlan/macvlan —
  anything but `bridge`/`host`/`none`/`container:*`): block goes in **ExtraParams**, as a run
  of `--network` flags: the primary first, then one `--network name=X,ip=Y,alias=Z[,mac-address=W]`
  per additional network. dockerMan's own `hasNetworkParam()` sees our `--network` and omits
  its own `--net=`, but still emits bare `--ip=<Fixed IP>` — so the primary token has to be
  emitted by us too, in short form `--network <primary>` normally.
- **Primary carries a MAC** (`<MyMAC>`/`contMyMAC` set): emit `--network name=<primary>,mac-address=<mac>`
  instead of the short form (never combine `ip=` with the primary token — dockerMan's bare
  `--ip` would conflict with it). **Live-probed on this host** (not just read from source):
  bare `--ip=X` + `--network name=<bridge-driver-net>,mac-address=Y` at `docker run` succeeds
  and both apply correctly. Tried against `br0` (ipvlan) first — Docker itself rejects any MAC
  on an ipvlan network ("ipvlan interfaces do not support custom mac address assignment"),
  independent of which path emits it. `include/api.php` gates MAC emission on the primary's
  driver being `bridge` (`netman_docker_network_driver() === 'bridge'`) before honoring it.
- **Primary is `bridge`/`host`/`none`/`container:*`**: block goes in **PostArgs**, as
  `&& docker network connect [--ip X] [--alias Y] <net> <containerName>` chunks, chained with
  `&&` and appended after whatever PostArgs the user already has (dockerMan appends PostArgs
  verbatim after the image — chaining with `&&` is correct whether or not the user's own
  PostArgs is empty). MAC is not supported on this path (`docker network connect` has no
  `--mac-address` — confirmed via `--help`); the UI disables the MAC field here.
- **`state.json`** (`/boot/config/plugins/docker.netman/state.json`) records what the plugin
  last wrote per container, keyed by name. The template is always re-parsed as truth; state.json
  only disambiguates "the plugin's own block" from something hand-typed. If a `--network` run
  or `docker network connect` chain is found that doesn't match state.json's record for that
  container (including "no record at all"), the container is **manually managed**: `api.php`'s
  `save` action refuses to rewrite that field and reports it back to the UI, which shows a red
  chip and tells the user to remove the hand-written block first or use the other path.
- Parsing/building both live in `plugin/include/netman.php` (server, PHP) and
  `plugin/docker-netman-core.js` (client + node, same logic, UMD-wrapped so the browser injector and
  `node tests/js.test.js` share one implementation). Both are pure, side-effect-free, and
  round-trip: parse → edit → serialize → parse is idempotent (tested).


## Injection mechanism

Generic rules (page lookup by `basename`, why `Menu="Docker:N"` concatenates instead of tabbing,
the `Menu="Buttons"` injector vehicle, capture-phase submit listener, fail soft, feature detection,
strict-mode IIFE): see the `unraid-webgui-plugin-pages` skill, "Page registration". The 0.1.0–0.3.1
narrative (the `Docker:3` attempt, the screenshot) is in `docs/history.md`.

- `DockerNetMan.page`: `Menu="Tasks:92"`, `Title="NetMan"`, `Name="NetMan"` (the top-bar label is the `Name` header, else
  the file basename, so without it the tab read DOCKERNETMAN: found live in 0.4.0), `Code="e911"` (the stock `icon-network` glyph), at
  `/DockerNetMan`: its own top-bar tab, directly after SecretsMan (`Tasks:91`; nothing else sits at 92 on this
  host: Tasks are 1 Dashboard/Main, 2 Shares, 4 Settings, 50 Plugins, 60 Docker, 70 VMs, 80 Apps, 90 Tools). Since 0.4.0
  it is only a thin iframe host plus "Open full page", exactly like `SecretsMan.page`; the UI is the Preact app in
  `ui/` (see "Web app (0.4.0)"). Before 0.4.0 it was a `Menu="Utilities"` page at `/Settings/DockerNetMan`.
- `DockerNetManInject.page`: `Menu="Buttons:5"`, `Link="nav-user"`, `Markdown="false"`, a pure `<script>`.
  - On `^/Docker` (excluding the Add/Update Container paths) it appends one button into `.js-actions`,
    next to the stock Add Container button, linking to `/DockerNetMan`.
  - On `^/Docker/(AddContainer|UpdateContainer)` it finds `input[name=contMyMAC]`, walks up to its row
    container and inserts a matching sibling row below it (`insertBlock()`: `closest('dl')`, then
    `closest('div')`; unchanged since 0.1.0, confirmed correct in the owner's real browser at 0.3.1).
  - A capture-phase listener on `document` composes `contExtraParams`/`contPostArgs` before the form's
    inline `onsubmit="prepareConfig(this)"` reads them.
  - Fails soft: endpoint unreachable or row not found means no section and the form submits untouched;
    nothing throws past the try/catch on the compose step.
  - `window.dockerNetman.inject()` is exposed to re-run it from devtools.

## CSRF

Mechanism, failure shape (200 with an empty body) and the no-plugin-side-check rule: see the
`unraid-webgui-plugin-pages` skill, "Requests: transport and CSRF". Repo specifics (constraints 1–2):

- `include/api.php` has no CSRF check of its own, deliberately.
- The web app (`ui/src/lib.ts` `postRaw`/`postJson`) is plain `fetch`, so it sends the token itself: as a body field and as
  `X-CSRF-Token`, urlencoded only (never multipart), with the token read from `var.ini` by `app/index.php` (`data-csrf`).
- `DockerNetManInject.page` uses plain `XMLHttpRequest`, so its shared `dnmPost()` helper reads
  `window.csrf_token` and sends it **both** as `X-CSRF-Token` and as a `csrf_token` body field
  (`local_prepend.php` reads `$_POST['csrf_token'] ?? $_SERVER['HTTP_X_CSRF_TOKEN']`). Without it,
  `fetchNetworks()` saw the empty body and the injector reported "endpoint unreachable".
- **Any future page here that talks to `include/api.php` outside jQuery needs the same treatment** (the app and the injector both do).

The live curl proof (same session, with and without the token) is in `docs/history.md`.

## Web app (0.4.0) and Adopt (0.3.8)

- **Architecture = SecretsMan 1.1.x's.** `plugin/app/index.php` is the shell the webGUI serves at
  `plugins/docker.netman/app/index.php` (lowercase path: an uppercase first letter routes to `template.php`). It emits
  only `csrf_token` from `var.ini` (escaped, `no-store`), derives `data-theme` from the Unraid theme (black/gray dark,
  white/azure light), applies a stored light/dark choice in an inline script before the stylesheet, loads
  `../docker-netman-core.js` (so the editor's fragment preview uses the same builder as the injector, not a third
  copy) and the content-versioned `assets/app.js|css`. Env overrides `NETMAN_VAR_INI` / `NETMAN_DYNAMIX_CFG` are for tests.
- `ui/` is Preact + Vite + TypeScript (`npm test` = vitest, `npm run check:contrast`, `npm run build`). Output names
  are fixed (`assets/app.js`, `assets/app.css`, no sourcemaps) so the archive stays reproducible; CI pins Node
  `22.23.4`; `NETMAN_UI_DIST` points `build-plugin.sh` at a prebuilt dist (`tests/run.php` builds it once).
- UI behaviour: Containers card first (one line each, "Edit" opens one inline editor at a time), Networks card second
  (member count expands; trash icon, reserved networks have none). Header: theme switch (`auto|light|dark`, localStorage
  key `netman-theme`, shared by the iframe and standalone page), search (re-opens collapsed cards), Expand/Collapse all.
  The two toggles keep their old keys `dnm.showPrev` / `dnm.onlyExtra` (`'1'`/`'0'`). Apply all asks first (it is
  the only intentional behaviour change from the old page). All dialogs are in-app modals (no `swal`/`confirm`).
- **`normalizeRows()` (`ui/src/lib.ts`) is the `save` payload shape** (trimmed, empty optionals `null`, blank-network
  rows dropped). The server compares what it parses back against `state.json`; a different shape could flip a
  container to "manually managed". Tested; do not loosen it.
- `syncState()` keeps the old page's precedence: no template, previous, native overlap, stopped, manual, then sync/drift.
- **The app renders `native_networks` / `native_overlap` when the server sends them** (both optional). Main's server
  does not (that is the unreleased `feature/native-extranetworks` work), so on main that code path is inert and covered
  only by a fixture test (`App.test.tsx`), never observed live.
- UI follows DESIGN.md. No colour, spacing, radius or shadow values outside the vendored `ui/src/styles/tokens.css`;
  changes go upstream to kmbrimble/design-system and are re-vendored. `ui/src/styles/*.css` are vendored from
  design-system `b6c9faf` (headers say so); `npm run check:contrast` checks the pairs.
- Namespace-style names (container and network names) display in their real case; sorting is case-insensitive
  (`netman_name_cmp` server-side, `compareNames` for the networks list).
- Still true from 0.3.6: driven by `docker ps -a` joined to templates by exact `<Name>` (`netman_join_containers`);
  "Previous Apps" templates only with `include_previous=1`; containers with no template are listed read-only.
- **Adopt** (`netman_adopt`, API `adopt`, `dry_run=1` reports the plan): records a hand-written
  block in state.json. Exact canonical match → state only, template untouched; otherwise only
  that path's field (PostArgs or ExtraParams, never the other) is normalised, after a confirm
  showing before/after. Refuses when any network token is not accounted for by a parsed row.
  Never pins live IPs: the editor only offers them as a one-click fill.
- The docker.networks (mstrhakr) plugin was checked for and is **not installed** on this host.
- The old stock-styled page (0.3.6-0.3.9) and the owner's 0.3.7 real-browser measurements of it are in `docs/history.md`.

## Real-browser fixes (0.3.0–0.3.1)

The rules these produced are constraints 3 and 7 below, and the generic styling rules are in the
`unraid-webgui-plugin-pages` skill, "Styling and widgets". The full write-up (the `rowsEqual(null)`
crash with before/after repro, the `width: auto` measurement, row stacking) is in `docs/history.md`.

## .plg parse guard

Generic `.plg` XML rules: see the `unraid-plugin-packaging` skill, "The .plg is XML with entity
substitution". Here: `scripts/check-plg.php` is the guard. It runs in the Gitea CI, `release.yml` (GitHub)
and `scripts/build-plugin.sh` (which refuses to build on failure). 0.3.6 was unparseable because of a raw
`<Name>` in CHANGES; escape angle brackets there as `&lt;`/`&gt;`.

## Browser verification

Method (scratch `playwright-core`, cached `chrome-headless-shell`, reused root session, never print the
session id, prefer it to in-app preview panes): see the `unraid-webgui-plugin-pages` skill, "Verifying in
a real browser". Here:

- `scripts/browser-check.js` wraps it (repo only; `build-plugin.sh` packages `plugin/` alone, so it never
  reaches the txz):
  `NODE_PATH=<scratch>/node_modules node scripts/browser-check.js /Main /Docker /DockerNetMan`.
  It reports load time, pageerrors, console errors, `typeof window.before` and leaked globals.
- Session: the newest `/var/lib/php/sess_*` containing `unraid_user|s:4:"root"`, as cookie `unraid_` +
  md5(`192.168.0.10`).
- `tests/globals.test.js` and the strict-mode IIFE scoping stay as hygiene.

The 0.3.9 results, the 0.3.8 `before.getTime` false alarm and the Adopt acceptance run are in
`docs/history.md`.

## Known limitations (see README.md for the user-facing version)

- MAC on an additional network only works via ExtraParams, and only when that network's own
  driver supports it (bridge does, ipvlan doesn't).
- PostArgs path conflicts with this host's Tailscale integration: `xmlToCommand()` splits
  `PostArgs` at the first `;` when Tailscale is enabled, which our `&&`-chained block was never
  designed to coexist with. Not handled — avoid combining the two.
- Uninstall does not touch templates or `state.json` — additional-network fragments already
  written keep working with the plugin removed, by design (documented in the `.plg`'s remove
  block and README.md).

## Shipping model

Packaging, install and CDN-cache rules: see the `unraid-plugin-packaging` skill; release mechanics: the
`forge-release` skill. Here:

- Self-hosted `.plg` installed by URL from `raw.githubusercontent.com`, packaged `.txz` attached to a
  GitHub Release, `dist/` gitignored (artifacts are release assets, not repo contents).
- `scripts/build-plugin.sh` assembles the tree; CI runs it (release-readiness on Gitea, then the GitHub
  release workflow on the mirrored tag). The archive is deterministic (sorted names, fixed mtime), so the
  md5 is the same on both runners.
- The raw `.plg` caches for `max-age=300`. The versioned `.txz` filename is not the risk (each version's
  name is unique); the stale `.plg` body is. `scripts/install-on-host.sh` waits for the raw `.plg`'s
  `&version;` and `&md5;` to match the release. The 0.3.2 → 0.3.3 incident is in `docs/history.md`.

## Version numbers are compared with strcmp

Rule: see the `unraid-plugin-packaging` skill, "Versions are compared with strcmp". `0.3.10` would sort
before `0.3.9`. Enforced here by `.github/workflows/release.yml` (on GitHub, at the mirrored tag), which
refuses a version that does not sort after the previous tag as a plain string, and by
`scripts/install-on-host.sh`, which checks against the host's installed version and names its `--forced`
flag when crossing a boundary is intended. Keep components single-digit, or zero-pad.

## Test command

`php tests/run.php` (builds the UI and the package; includes the `web:` subprocess tests of `api.php` via
`tests/web_tests.inc.php`, a fake `docker` on PATH and `NETMAN_STATE_PATH` / `NETMAN_TEMPLATES_DIR` overrides),
`node tests/js.test.js`, `node tests/globals.test.js`, and in `ui/`: `npm test` (vitest), `npm run check:contrast`,
`npm run build`. All run locally in the claude-code container (PHP 8.4 CLI is on PATH; Node 22). Gitea CI
(`.gitea/workflows/ci.yml`) runs `php -l`, `scripts/check-plg.php`, the UI steps and all of the above on PHP 8.4 (job
`php84`), and `php -l`, the plg check and the PHP tests on 8.1 (job `php81`, which still needs Node because the PHP
tests build the UI). `tests/run.php` prints a `skipped` count; a skip only happens when `npm` is missing and CI has it.

## Plugin manager quirk

Rule (a `FILE` with no `<MD5>`/`<SHA256>` is never overwritten; never re-check the package md5): see the
`unraid-plugin-packaging` skill, "FILE blocks and checksums". Constraint 4 below is this repo's instance
(0.1.0 → 0.2.0 broke upgrades with "package md5 mismatch"); the narrative is in `docs/history.md`.

## Live verification (C.3, terrible-butler)

The core design was proven end to end on the real host: `save` wrote the PostArgs block into
`my-terrible-butler.xml`, dockerMan's real `xmlToCommand()` rendered it, `rebuild_container` recreated
the container and `proxynet` came back at its static IP with no manual connect. Full trace in
`docs/history.md`; method in the `unraid-live-host-testing` skill.

- `docs/verify-recreate.sh` is the read-only check for that container (`docker inspect` + `curl` +
  `docker exec ... curl`, no writes): run it before a recreate, right after, and after a
  `docker stop`/`docker start` cycle.
- Use `rebuild_container <name>` for any live recreate, not raw `docker stop`/`rm`.
- Leftover backup `/boot/config/plugins/unraid-multinet/backup/my-terrible-butler.xml.bak` sits at the
  pre-rename flash path. Nothing reads it.

## Host facts used here (see `/projects/unraid-ops/host-facts.md` for the full set)

Unraid 7.3.4 (`/boot/changes.txt`), Docker 29.8.2 daemon on the host; checked 2026-11-04. This container's
own docker CLI is now 29.9.2 (it was 20.10 during the build, which is why every live docker test then went
through `ssh root@192.168.0.10`); syntax-sensitive docker commands still run on the host, per the
`unraid-live-host-testing` skill. No python3 on the host; PHP 8.4 is. The webGui's :443 is loopback-only
(`USE_SSL="no"`, see "Code review"); pages are verified over :81 in headless Chromium (see "Browser
verification"). The build-time note about a failed TLS handshake on :443 is in `docs/history.md`.

## Non-negotiable constraints

Each of these looks like a bug, an omission or an easy tidy-up, and is none of those. The reasoning is
in the skill or `docs/history.md` section named after each. Read it before changing any of them.

1. **No CSRF check in `plugin/include/api.php`.** webGui's `local_prepend.php` already enforces
   it and *consumes* the token; a second check would 403 every legitimate request. ("CSRF" above;
   `unraid-webgui-plugin-pages`)
2. **Any caller of `include/api.php` that is not jQuery must send the token itself** — the
   `dnmPost()` helper in `DockerNetManInject.page`, both as `X-CSRF-Token` and as a body field.
   Unraid's `$.ajaxPrefilter` never touches a plain `XMLHttpRequest`. ("CSRF" above)
3. **Plugin buttons injected into stock pages use `width: fit-content !important`** (plus a `min-width`) in
   `DockerNetManInject.page`. `width: auto` was measured live and does not work here; `display: inline-block
   !important` on top of it made no difference either. (The 0.4.0 app lives in an iframe, so stock CSS never
   reaches it; it uses the design system's `.btn` classes instead.)
   (`docs/history.md` "0.3.0 real-browser fixes")
4. **No md5 sidecar or custom md5 re-check in `docker.netman.plg`.** The plugin manager verifies
   the `.txz`'s own `<MD5>`; the sidecar could never be rewritten and broke upgrades.
   (`docs/history.md` "Plugin manager quirk"; `unraid-plugin-packaging`)
5. **`netman_write_template_field()` edits raw template text, not a re-serialized
   `SimpleXMLElement`** (`plugin/include/netman.php`) — so no other element in the user's
   template can drift. ("Serialization design")
6. **`plugin/README.md`, not the repo's `README.md`, is what `scripts/build-plugin.sh` packages.**
   `dynamix.plugin.manager/include/ShowPlugins.php` Markdown-renders `plugins/<name>/README.md`
   into a one-line description cell on the Plugins tab. Shipping the repo README put its `# Docker
   NetMan` H1 in there and rendered the row several times the size of every stock plugin beside
   it (issue #1). Keep the packaged file to the stock shape — `**Name**`, blank line, one
   paragraph, no headings and nothing long enough to trip the page's readmore collapse
   (`maxHeight:80`). Repo docs go in the repo README; they are not the plugin's description.
7. **`rowsEqual(a, null)` returns `true` ("unknown — trust what was parsed"), and the injector
   passes `null`, never `[]`** (`plugin/docker-netman-core.js`, `DockerNetManInject.page`). `[]`
   means "expected nothing" and would mark every existing row manually-managed. The PHP twin
   `netman_rows_equal(array $a, array $b)` is strictly typed and never sees `null`:
   `netman_state_get()` returns `[]` when there is no record. `tests/js.test.js` covers
   `expected=null` on both paths. (`docs/history.md` "0.3.0 real-browser fixes")

Inherited from `unraid-ops`, and applying here too:

Never reboot the host. Never stop the array or Docker. Never touch a container unrelated to the
task at hand. No new host packages. Report before touching a stock OS file. Verify outcomes
against real state (`docker inspect`, the actual template bytes, an actual HTTP response) —
never trust a log line or exit code alone.

## Deploy and verify

**Forge (changed 2 Nov 2026): Gitea is primary, GitHub is a read-only push mirror.** Develop against
`https://git.kiztigs.com/kmbrimble/unraid-docker-netman` (`origin`, gt credential helper; `gt`, not `gh`, for issues/PRs).
`github.com/kmbrimble/unraid-docker-netman` receives every push to Gitea within about a minute (`sync_on_commit`, plus a
10-minute sweep: push mirror `interval: 10m0s`, checked via the Gitea API 2026-11-04) and **must never be pushed to directly**: the mirror force-syncs and prunes refs, so anything that exists only
on GitHub is lost. GitHub has Issues, Wiki, Projects, Discussions and PRs switched off. The `.plg` URLs
(`raw.githubusercontent.com/.../main/docker.netman.plg` and the release assets) deliberately still point at GitHub.
`main` is protected on Gitea: changes go through a PR, both CI checks (`CI / php84 (pull_request)`, `CI / php81 (pull_request)`)
must be green, and butler-bot merges its own green PRs (no human approval).

**Releasing needs nobody's say-so, but it is two steps now.** Nothing writes back to the repo after the tag any more (a push
mirror would discard it), so the md5 goes in *before* tagging:

1. In the PR that bumps `&version;` write the `###<version>` CHANGES entry and set `&md5;`. CI's release-readiness step
   (any untagged `&version;`) builds the package and fails with `set &md5; to <value>`; push again with that value. Merge.
2. Tag the merge commit on Gitea: `git tag v<version> && git push origin v<version>`. The tag is mirrored and
   `.github/workflows/release.yml` on GitHub rebuilds, requires the same md5, and publishes the Release with the `.txz` and
   `.md5` attached. See the `forge-release` skill. That workflow can also be dispatched by hand on GitHub as a dry run.

The CHANGES entry stays by hand and is used verbatim as the release notes. The tag path is proven: v0.4.0 (2026-11-13) was
the first release cut on this layout (PR, md5 committed before the tag, tag on Gitea, mirror, GitHub release workflow,
`install-on-host.sh`); the md5 built locally, by Gitea CI, in the release asset and on the host all matched. Gotchas met:
`gh`/`curl` to github.com from this container are blocked by the forge-guard hook unless `FORGE_GUARD=off` is set on the
`install-on-host.sh` run itself (it calls `gh` inside), and the release asset appears a couple of minutes after the tag.

`dist/` is still gitignored — artifacts are release assets, not repo contents.
`scripts/build-plugin.sh` can run locally for a test build (it needs `xz`, which the claude-code container
now has), but `&md5;` still comes from CI, never a local build.

Gitea CI runs on every push and PR; what it runs is under "Test command". The GitHub release workflow repeats
those checks rather than trusting a result it cannot see. The GitHub release workflow repeats those checks rather than trusting a result it cannot see.

**Installing on the host is the one step CI cannot do** — GitHub's runners (and the Gitea runner VM) have no route to
192.168.0.10. `scripts/install-on-host.sh` does it from the claude-code container, and running it
is part of releasing, not a separate decision: it confirms the release exists, waits until the
raw `.plg`'s own `&version;` *and* `&md5;` match the published release (the 5-minute CDN cache
described under "Shipping model", enforced rather than hoped for), runs `plugin install <raw URL>`
over SSH, then verifies the flash `.plg` version, the `/var/log/plugins` registration, the
installed tree, and that the packaged README is still the stock-shaped description. A failure
there is a failed release, not a flaky script.

Currently released and installed on this host: **v0.4.1** (0.4.0 had the wrong tab label; 0.3.9 before that) (`/boot/config/plugins/docker.netman/`).

## Code review

For `code-diff-reviewer` / `code-audit` / `code-security-audit`. Verified live 2026-09-04.

**Exposure: LAN-only, behind the Unraid webGUI login.** Both `.page` files and
`include/api.php` are served by the host's own nginx, which binds `192.168.0.10:81`,
`192.168.66.10:81` and loopback only (`USE_SSL="no"` in `/boot/config/ident.cfg`, so :443 is
loopback-only). There is no tunnel route, no reverse-proxy route and no port forward reaching
it: `unraid.kiztigs.com` is NXDOMAIN at Cloudflare's own nameservers, and the single enabled
Nginx Proxy Manager entry for that name forwards to `172.17.0.1:81`, where nothing listens.
Unraid Connect remote access is unconfigured (`myservers.cfg` is 0 bytes) and the Tailscale
plugin sits in `plugins-removed`. Every request passes nginx's global
`auth_request /auth-request.php` — an unauthenticated GET to a plugin script returns
`302 → /login`. **Not internet-facing; do not escalate on exposure alone.**

**Modules that own data users rely on:**

- `netman_write_template_field()` (`plugin/include/netman.php`) — the highest-risk function
  here. It rewrites the user's live dockerMan template at
  `/boot/config/plugins/dockerMan/templates-user/my-<name>.xml` (the flash file that *defines*
  the container) by `preg_replace` on raw text plus a bare `file_put_contents` — **no temp file,
  no rename, no backup**, unlike `netman_state_save()` a few lines earlier. A wrong pattern or a
  torn write leaves a template dockerMan can no longer recreate the container from.
- `case 'save'` (`plugin/include/api.php`) — the commit path: template first, `state.json`
  second, not atomic across the two. A failure between them leaves the template changed and this
  plugin's record of what it wrote stale — which is precisely the input `manually_managed` uses
  to decide whether it may rewrite a block.
- `case 'apply'` (`plugin/include/api.php`) → `netman_docker_network_connect/disconnect`
  (`plugin/include/docker.php`) — the only path that mutates live Docker state.
- `state.json` (`/boot/config/plugins/docker.netman/state.json`) — the sole record of what this
  plugin wrote. Lose or corrupt it and every managed container reads as `manually_managed` and
  the plugin refuses to touch it.

**Infrastructure this repo depends on but does not contain.** A reviewer seeing "nothing in this
repo implements X" for any of these is wrong:

- **CSRF and authentication are enforced upstream** — `webGui/include/local_prepend.php`
  (Unraid's global `auto_prepend_file`) and nginx's `auth_request`. Nothing here checks either,
  deliberately: see "CSRF" above. "No CSRF check in `api.php`" is a known false positive.
- **dockerMan** owns the template format, `xmlToCommand()` (which turns the `ExtraParams` /
  `PostArgs` written here into a real `docker run`), and `rebuild_container`/`update_container`.
- **`unraid-secretsman`**, a sibling plugin, live-patches that same `xmlToCommand()` in
  `/usr/local/emhttp/plugins/dynamix.docker.manager/include/Helpers.php` on this host.
- **The Unraid plugin manager** verifies the `.txz` against the `<MD5>` in the `.plg` — see
  constraint 4 and `docs/history.md` "Plugin manager quirk" for why re-checking it here was actively wrong.
- **`window.csrf_token`** (declared by webGui's `HeadInlineJS.php`) and Unraid's global
  `$.ajaxPrefilter` (which only helps jQuery callers; the app sends the token itself, see "CSRF").
- **The host's `docker` CLI and daemon** — every function in `plugin/include/docker.php` shells
  out to them.

**Test reality.** Covered: `tests/run.php` loads `plugin/include/netman.php` (parse/serialize round-trips on both
paths, idempotence, `manually_managed` drift, the `expected=null` regression, `netman_ip_in_subnet`,
`netman_choose_path`, `netman_write_template_field` against a temp XML file) and, since 0.4.0, runs **`api.php` itself as
a real subprocess for every action** (`web:` tests: non-POST and unknown-action rejection, networks, network
create/delete guards, containers, get, preview, save, manually-managed refusal, adopt dry-run and commit, apply)
against a fake `docker` and temp state/template paths, plus the `app/index.php` shell and the packaged archive layout.
`ui/` has vitest checks of the pure logic (`lib.test.ts`) and the whole app against a fake API (`App.test.tsx`).
`tests/js.test.js` covers `docker-netman-core.js`.

Still not covered by any test:

- `plugin/include/docker.php` against a **real** docker: the `web:` tests use a fake `docker` script, so argument
  syntax and real output formats are only proven by live use.
- `netman_state_load/save` failure modes (disk full, torn write) and `netman_write_template_field`'s non-atomic write.
- How the rendered app looks and behaves: only a live browser check shows that (see "Browser verification"); vitest
  runs in jsdom with no layout. `DockerNetManInject.page` has only the vm-sandbox hygiene test.
  Every injector bug ever found was found by the owner in a real browser: `docs/history.md` "0.3.0 real-browser fixes".

**A change to `docker.php` or `DockerNetManInject.page` has no test that can fully exercise it.** Treat
that as the strongest defect signal available in this repo, and say plainly that only a live
browser or host check can confirm such a change.
