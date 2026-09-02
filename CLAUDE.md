# unraid-multinet — CLAUDE.md

Concise design record, not a diary. Built end to end from `docs/SPEC.md` (kept in the repo for
reference — read it first for full rationale; this file condenses it plus what building it
actually confirmed).

## What this is

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
  driver being `bridge` (`multinet_docker_network_driver() === 'bridge'`) before honoring it.
- **Primary is `bridge`/`host`/`none`/`container:*`**: block goes in **PostArgs**, as
  `&& docker network connect [--ip X] [--alias Y] <net> <containerName>` chunks, chained with
  `&&` and appended after whatever PostArgs the user already has (dockerMan appends PostArgs
  verbatim after the image — chaining with `&&` is correct whether or not the user's own
  PostArgs is empty). MAC is not supported on this path (`docker network connect` has no
  `--mac-address` — confirmed via `--help`); the UI disables the MAC field here.
- **`state.json`** (`/boot/config/plugins/unraid-multinet/state.json`) records what the plugin
  last wrote per container, keyed by name. The template is always re-parsed as truth; state.json
  only disambiguates "the plugin's own block" from something hand-typed. If a `--network` run
  or `docker network connect` chain is found that doesn't match state.json's record for that
  container (including "no record at all"), the container is **manually managed**: `api.php`'s
  `save` action refuses to rewrite that field and reports it back to the UI, which shows a red
  chip and tells the user to remove the hand-written block first or use the other path.
- Parsing/building both live in `plugin/include/multinet.php` (server, PHP) and
  `plugin/multinet-core.js` (client + node, same logic, UMD-wrapped so the browser injector and
  `node tests/js.test.js` share one implementation). Both are pure, side-effect-free, and
  round-trip: parse → edit → serialize → parse is idempotent (tested).

## Injection mechanism

- `MultiNet.page`: `Menu="Docker:3"` tab. Plain page, own JS, talks to `include/api.php`.
- `MultiNetInject.page`: `Menu="Buttons:5"`, `Link="nav-user"`, `Markdown="false"` — a pure
  `<script>` injector, the supported non-patching vehicle (`DefaultPageLayout.php` evals every
  `Menu="Buttons"` page in `<head>` on every page load; `ipmi`'s `IPMIButton.page` is the stock
  precedent). Only acts when `location.pathname` matches `^/Docker/(AddContainer|UpdateContainer)`.
  Finds `input[name=contMyMAC]`, walks up to its row container (`dl`/`div`), inserts a matching
  sibling row below it. Hooks the form's submit via a **capture-phase listener on `document`**,
  not the form itself — capture/bubble ordering is by DOM tree position, so a document-level
  capture listener runs before the form's own bubble-phase inline `onsubmit="prepareConfig(this)"`
  handler regardless of registration order on the same element. Composes `contExtraParams`/
  `contPostArgs` there, before dockerMan reads them. Fails soft throughout: endpoint unreachable
  or the row not found both degrade to "no section, form submits untouched" rather than blocking
  submit — nothing here throws past a try/catch on the compose step.
- **Not verified in a real browser** — this container has none. `window.multinet.inject()` is
  exposed for the owner (or a future session with one) to re-run and inspect in devtools; the
  DOM insertion point (`closest('dl')` / `closest('div')` fallback chain) is a best-effort read
  of `CreateDocker.php`'s markdown-generated markup, not something rendered and checked here.

## CSRF

No explicit check in `include/api.php` — `webGui/include/local_prepend.php` (Unraid's global
`auto_prepend_file`) already enforces CSRF on every plugin POST and **consumes**
`$_POST['csrf_token']` once it validates. A second check would always see it empty and 403
every legitimate request (this is `unraid-secretsman`'s own documented mistake-and-revert, not
a hypothetical — its `store_api.php` has the same comment). Trust the platform's enforcement.

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

Same as `unraid-secretsman`: self-hosted `.plg` installed by URL from
`raw.githubusercontent.com`, packaged `.txz` attached to a GitHub Release, `dist/` gitignored
(built artifacts are release assets, not repo contents — confirmed by checking
`unraid-secretsman`'s actual tracked files, not just its `.gitignore` wording). `scripts/build-plugin.sh`
assembles the tree and prints the exact next manual steps (bump `.plg`'s `&version;`/`&md5;`,
commit, `gh release create`).

## Testing

`php tests/run.php` (no framework; run over SSH against the host's PHP 8.4 — this dev
container has no local PHP) and `node tests/js.test.js`. CI (`.github/workflows/ci.yml`) runs
both plus `php -l` on PHP 8.1 and 8.4.

## Host facts used here (see `/projects/unraid-ops/host-facts.md` for the full set)

Unraid 7.3.1, Docker 29.5.2 CLI on host (this container's own docker CLI is 20.10 and lacks
advanced `--network` syntax — every live docker test here went through
`ssh root@192.168.0.10` or the host-socket `docker run --rm -v /usr/bin/docker:...` wrapper,
never this container's own `docker`). No python3 on host; PHP 8.4 is. webGui HTTPS (port 443,
localhost-only) did not accept a plain TLS handshake over SSH+curl during this build
(`SSL routines::wrong version number` — unexplored further, out of scope; see "Not verified in
a real browser" above) — live page-HTML verification (SPEC.md C.1/C.2) was not completed for
that reason, beyond confirming the plugin installed and its files landed correctly.

## Standing constraints (inherited from unraid-ops, apply here too)

Never reboot the host. Never stop the array or Docker. Never touch a container unrelated to the
task at hand. No new host packages. Report before touching a stock OS file. Verify outcomes
against real state (`docker inspect`, the actual template bytes, an actual HTTP response) —
never trust a log line or exit code alone.
