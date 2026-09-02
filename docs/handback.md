# Handback

Where this stands after the initial build + live verification session (2026-09-02/03), for
whoever (human or a future session) picks this up next.

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

- **Real-browser DOM injection on the Add/Update Container form**
  (`MultiNetInject.page`) — this dev container has no browser, and the webGui's HTTPS listener
  (`127.0.0.1:443`, plain HTTP not TLS despite the port number — see `CLAUDE.md` "Host facts")
  couldn't be driven headlessly with the auth this session had. **Ask the owner to**: open
  **Docker → Add Container** (or **Update Container** on an existing one, e.g.
  `terrible-butler`), scroll to the Fixed MAC address row, and confirm:
  1. An "Additional networks" row appears directly below it, with a network dropdown (populated
     from the live `docker network ls`, excluding `bridge`/`host`/`none` and the currently
     selected primary), Fixed IP / Alias / MAC fields, and a live fragment preview.
  2. Adding a network, filling in an IP, and hitting **Apply** actually writes it (check the
     resulting template's `ExtraParams`/`PostArgs` over SSH, or reload the Update Container
     page and confirm the row reappears — the injector is supposed to parse it back out and
     hide the raw fragment from the visible Extra Parameters/Post Arguments fields).
  3. If it *doesn't* appear: open devtools and run `window.multinet.inject()` — this is exposed
     specifically so the injection point can be re-run and inspected without a page reload.
     `MultiNetInject.page`'s `insertBlock()` uses a `closest('dl')` → `closest('div')` →
     `parentElement` fallback chain to find `contMyMAC`'s row container — if dockerMan's actual
     rendered markup doesn't match any of those, that function is the first place to fix.
- **The Networks tab's "create network" form** (ipvlan/macvlan with a parent interface) has
  unit-tested serialization underneath (`multinet_docker_network_create()`) but the form itself
  hasn't been clicked through in a browser either — same blocker as above.

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
