# Handback

Where this stands after the initial build + live verification session (2026-09-02/03), for
whoever (human or a future session) picks this up next.

**Renamed to Docker NetMan at 0.3.0** (repo `kmbrimble/unraid-docker-netman`, plugin id
`docker.netman`) — see `CLAUDE.md` "Name" for why. Everything below predates the rename and
uses the names that were current at the time (`unraid-multinet`, `MultiNet.page`,
`/usr/local/emhttp/plugins/unraid-multinet/...`, etc.) — read it as history, not as current
paths; the "0.3.0" section at the end has the current state and what changed.

## What's proven, with evidence

- **The core design works end to end on the real host.** `terrible-butler` (primary `bridge`,
  previously kept on `proxynet` at 172.18.0.3 by a manual `docker network connect` the owner
  ran by hand) was switched over to the plugin: `include/api.php`'s `save` action wrote
  `<PostArgs>&amp;&amp; docker network connect --ip 172.18.0.3 proxynet
  terrible-butler</PostArgs>` into the live template; dockerMan's own `rebuild_container`
  script (the real Force Update code path) recreated the container from that template with
  **zero manual `docker network connect` afterwards** — both `bridge` and `proxynet` came back
  automatically, `proxynet` at the correct static IP. Confirmed via `docker inspect` (new
  container ID, both networks present) and via the reverse-proxied site
  (`https://butler.kiztigs.com/`) staying at HTTP 200 through the recreate and a subsequent
  `docker stop`/`start` cycle. Full trace: `CLAUDE.md` "Live verification".
- **The library is unit-tested and lints clean** on PHP 8.1 and 8.4 (CI) and in this dev
  container's PHP 8.4-over-SSH runs: `php tests/run.php` (42 checks — round-trips for both
  paths, the manually-managed refusal, the primary-with-MAC case, PostArgs with pre-existing
  user args, IP-in-subnet validation, XML-write byte-preservation of every other template
  field) and `node tests/js.test.js` (14 checks, same design's JS twin).
- **The plugin installs and uninstalls through the real mechanism**, not pre-staged files:
  `plugin install <raw .plg URL>` on a clean host, md5-verified, landed at the correct absolute
  path (`/usr/local/emhttp/plugins/unraid-multinet/...`), `state.json` initialized.
- **The MAC-on-primary serialization (spec fact 3) was live-probed, not assumed**: bare
  `--ip=X` + `--network name=<bridge-driver-net>,mac-address=Y` at `docker run` works and both
  apply correctly against a real bridge-driver network (`proxynet`); the same combination
  against `br0` (ipvlan) fails — Docker itself rejects any MAC on an ipvlan network,
  independent of which path emits it. `api.php` gates MAC emission on the primary's driver
  being `bridge`.

## What's untested

Real-browser testing happened in the 0.2.0 session (this dev container still has no browser
itself — the owner drove it) and found two real bugs, both fixed and re-verified against the
live host — see "Live verification" below and `CLAUDE.md`'s "Injection mechanism"/"CSRF"
sections for the full trace:

1. The Networks/Containers UI wasn't reachable as a Docker tab at all — `Menu="Docker:3"` just
   got concatenated onto the bottom of the Docker page, because that page's `Menu="Docker:1"`
   anchor sets `Tabs="false"`. Moved to its own `Settings/MultiNet` page (0.1.0 → 0.2.0), with a
   small button injected on the Docker page linking to it.
2. `MultiNetInject.page`'s calls to `include/api.php` never sent a CSRF token (jQuery's global
   `$.ajaxPrefilter` does this for `MultiNet.page` automatically; the injector's own
   `XMLHttpRequest` calls don't get that for free) — every request silently 0-byte'd out via
   Unraid's `csrf_terminate()`, which the injector correctly reported as "endpoint unreachable".
   Fixed by sending `window.csrf_token` as both the `X-CSRF-Token` header and a `csrf_token`
   body field.

**Verified server-side against the real host after the fix** (v0.2.0, reinstalled from the
released URL): `GET /Settings/MultiNet` returns 200 and contains the page's own markup
(`mn-networks`, `mn-containers`, the table structure); `GET /Docker/DockerContainers` returns
200 with **zero** occurrences of `mn-networks`/`mn-containers` (confirming the old inline UI is
gone from that page) and does load `MultiNetInject.page`'s script + `multinet-core.js`; a
CSRF-bearing POST (`X-CSRF-Token` + a real session cookie, reused from an active
`/var/lib/php/sess_*` file rather than a login this session doesn't have credentials for) to
`include/api.php` returns real JSON (`action=containers` listing every template). These prove
the server-rendered HTML and the API are correct.

**Still not verified with actual JS execution in a browser** (this dev container has none —
the checks above are static HTML/HTTP, not a rendered DOM): confirm on the next real-browser
pass that:
- The **MultiNet** button visibly appears on the Docker page next to Add Container/Start All
  (inserted into `.js-actions` by `insertDockerButton()` on `DOMContentLoaded` — present in the
  page's script but not something a `curl` check can confirm actually ran/rendered), and
  clicking it navigates to `Settings/MultiNet`.
- The Add/Update Container form's "Additional networks" section now actually populates its
  network dropdown (this was the whole point of the CSRF fix — previously `fetchNetworks()`
  always got an empty body back and showed "could not reach the plugin endpoint"). If it
  *still* doesn't appear: open devtools and run `window.multinet.inject()` — exposed
  specifically so the injection point can be re-run and inspected without a page reload.
  `insertBlock()`'s `closest('dl')` → `closest('div')` → `parentElement` fallback chain to find
  `contMyMAC`'s row container is still unverified against dockerMan's actual rendered markup;
  if it doesn't land in the right place, that function is the first thing to fix.
- **The Networks tab's "create network" form** (ipvlan/macvlan with a parent interface) has
  unit-tested serialization underneath (`multinet_docker_network_create()`) but the form itself
  still hasn't been clicked through end-to-end (create a real scratch network via the UI, confirm
  it appears, delete it).

## How to use it

- **Docker → Networks** tab (`MultiNet.page`): network CRUD across the top, then a matrix of
  every container template below — each row's additional networks are editable inline, **Save**
  rewrites the template's `ExtraParams`/`PostArgs`, **Apply now** reconciles the *running*
  container's live network membership via `docker network connect`/`disconnect` without
  recreating it (the automated version of the manual step this plugin replaces). A red
  "manually managed" chip means the field already contains a `--network`/`docker network
  connect` block this plugin didn't write — remove it by hand first, or switch the container's
  primary network so the other path applies.
- **Add/Update Container form** (`MultiNetInject.page`): same rows, injected below the Fixed
  MAC address field, composed into the real form fields on submit — see "What's untested" above
  for how to verify this one specifically.

## The two paths and their limits

- **ExtraParams** (primary is a user-defined network — custom bridge, `br0`/`br0.66`, any
  ipvlan/macvlan): supports MAC per network, but only on networks whose driver is `bridge` —
  ipvlan rejects any MAC (Docker's own limitation, live-confirmed, not this plugin's).
- **PostArgs** (primary is `bridge`/`host`/`none`/`container:*`): no MAC support at all
  (`docker network connect` has no `--mac-address` flag). Also **incompatible with this
  container's Tailscale integration** if enabled — `xmlToCommand()` splits `PostArgs` at the
  first `;` when Tailscale is on, which this plugin's `&&`-chained block was never designed to
  coexist with. Not handled; avoid combining the two until it is.
- A container's primary network decides which path applies — there's no way to use both at
  once, and switching a container's primary network type (e.g. `bridge` → a custom network)
  changes which field the plugin writes to.

## Where things are

- Template backup made during the live test:
  `/boot/config/plugins/unraid-multinet/backup/my-terrible-butler.xml.bak` (byte-identical to
  the pre-edit original, confirmed via `md5sum` before any write — not needed for rollback in
  the end, left in place).
- `state.json`: `/boot/config/plugins/unraid-multinet/state.json` — currently has one real
  entry (`terrible-butler`).
- Release: `v0.1.0`, https://github.com/kmbrimble/unraid-multinet/releases/tag/v0.1.0. No code
  has changed since (`git diff v0.1.0 HEAD -- plugin/` is empty) — only this handback, the
  verify script, and README/CLAUDE.md updates recording the live-test results. Not worth a
  v0.1.1 for docs-only changes; the next code change should cut one.

## Session continuity note (for the owner)

This session runs through Claude Code's MCP connector, which has no auto-retry wrapper around
usage-limit pauses. If a session pauses on a limit, the CLI's own limit message shows the
5-hour window's reset time — today's (2026-09-02) reset was communicated as **00:39 on
2026-09-03**. Nothing in this repo depends on that timing; noted here only because it came up
during this session and the owner asked for it to be recorded for reference.

## 0.3.0: rename + real-browser fixes

The owner reviewed 0.2.0 in an actual browser (the first time this project got real-browser
testing) and found the CSRF bug had made the Add/Update Container injector effectively dead —
see `CLAUDE.md` "0.3.0 real-browser fixes" for the full root-cause trace on all four issues
found this round:

1. `rowsEqual(a, b)` crashed on `expected=null`, which is exactly what the injector passes on
   the edit page (no `state.json` client-side) — the crash aborted parsing, so an existing,
   correct network row silently disappeared instead of showing. This was the bug that made the
   whole feature look broken. Fixed and covered by new node tests, including the exact
   real-world `terrible-butler` PostArgs string.
2. The "Add network" button stretched full page width on a wide viewport (stock dockerMan CSS,
   same class of bug as secretsman's Browse-button fix).
3. Per-row fields ran across the page instead of stacking down it (unusable on phone width).
4. Renamed unraid-multinet → **Docker NetMan** (collided with an existing CA plugin, "Docker
   Networks" by mstrhakr) — every identifier renamed consistently (files, entities, API path,
   JS global, state.json location, page names), with an automatic one-time `state.json`
   migration from the old flash path baked into the new `.plg`'s install script.

**Verified this round** (all against the real host, not just the test suite):
- `netman_parse_post()`/`multinet.parseExtra` round-trip through the renamed code against
  terrible-butler's real, unmodified template — confirms the "templates need no migration"
  claim: the ExtraParams/PostArgs blocks don't reference the plugin's name at all, so the
  rename needed zero template changes, only the state.json copy.
- The old plugin was removed cleanly and Docker NetMan installed fresh from
  `https://raw.githubusercontent.com/kmbrimble/unraid-docker-netman/main/docker.netman.plg`.
- `state.json` migrated automatically (copied, old file left alone) and the migrated content
  makes `manually_managed` come out `false` for terrible-butler's real row, where the same
  parse with no state.json (simulating a fresh install with no migration) correctly comes out
  `true` — proving the migration is what makes the difference, not a coincidence.
- `terrible-butler` itself was **not** touched — still the same container ID from the 0.2.0
  session, both networks attached, site returning 200.

**Still not verified with actual JS execution in a browser**, same caveat as before: the visual
placement of the Docker-page button, and that the Add/Update Container form's network dropdown
and stacked-row layout render as intended. The `rowsEqual(null)` fix specifically should make
the previously-invisible row reappear — that's the one thing most worth the owner's next look.
