# Docker NetMan

*(formerly "unraid-multinet" — renamed to avoid ambiguity with an existing Community
Applications plugin; see "Compared to Docker Networks (mstrhakr)" below.)*

## How this was built

The code here — the parser, the API, both injected pages — was written by Claude Cowork and
Claude Code, session by session, not typed by hand. The problem, the design (which of
dockerMan's two fields to write to and when, what counts as "manually managed", when to refuse
a save rather than guess), and every decision about what shipped came from the repo owner, who
also did the acceptance testing. "Reviewed" here means something concrete, not a rubber stamp:
each release was installed on a real Unraid host, exercised against a real container recreated
through dockerMan's own Force Update path, and checked in an actual browser before being called
done — not just read back and assumed correct.

Unraid's dockerMan lets a container have exactly ONE network (Network Type + Fixed IP + MAC).
This plugin lets each container have **additional** networks — each with its own optional
fixed IP, alias, and (where the driver supports it) MAC — and makes them **persist across
reinstall, force update, and "Previous Apps"** by writing them straight into the container's
own template XML, the same file dockerMan already persists and re-applies. No runtime hook, no
plugin database, no patched core file.

## How it works

dockerMan builds `docker run` from two template fields it already exposes in the Add/Update
Container form: **Extra Parameters** and **Post Arguments**. This plugin writes a recognisable,
self-describing block into whichever one applies:

- **Primary network is a user-defined network** (a custom bridge, `br0`/`br0.66`, an ipvlan or
  macvlan network — anything except `bridge`/`host`/`none`/`container:*`): the block goes into
  **Extra Parameters**, as a run of `--network` flags — the primary plus one per additional
  network, in Docker's advanced `--network name=X,ip=Y,alias=Z[,mac-address=W]` syntax.
- **Primary network is `bridge`, `host`, `none`, or `container:*`** (Docker refuses to mix a
  non-user-defined primary with `--network` at create time): the block goes into **Post
  Arguments**, as a chain of `docker network connect` commands appended after the image, run
  once `docker run -d` returns — **with the fixed IP** (`--ip`), when one is set.

Either way, the fragment lives in the template dockerMan already owns — reinstall, force
update, and "Previous Apps" all go through the same `xmlToCommand()` path, so the additional
networks come back automatically with no separate persistence layer.

A small sidecar, `/boot/config/plugins/docker.netman/state.json`, records what this plugin
last wrote per container — used only to tell "the plugin's own block" apart from something you
typed into Extra Parameters/Post Arguments by hand. If your own text and the plugin's disagree,
the plugin shows the container as **manually managed** and refuses to touch that field rather
than risk clobbering something you wrote.

## Using it

- **Settings → Docker NetMan** (also reachable via a small **Docker NetMan** button next to Add
  Container/Start All on the Docker page): manage `docker network` (list/create/delete), and a
  table of every container template with its additional networks editable inline. **Save**
  rewrites the template; **Apply now** reconciles the running container's live network
  membership (`docker network connect`/`disconnect`) without recreating it — the automated
  version of the manual step this plugin exists to replace.
- **Add/Update Container** form: an "Additional networks" section appears directly below the
  Fixed MAC address row, so you can set them up at the same time as everything else, before
  ever hitting Apply.

## Compared to Docker Networks (mstrhakr)

There's an existing Community Applications plugin,
[Docker Networks](https://github.com/mstrhakr/docker.networks) by mstrhakr (support thread
"[PLUGIN] Docker Network Manager"), that also writes a `docker network connect` chain into a
template's Post Arguments. Stated factually, not as a knock on it — the two differ in scope:

- Its `dockerNetworksBuildTemplateConnectCmd` omits `--ip`, so it doesn't carry a fixed IP
  through a recreate the way this plugin does — persisting the exact IP (so reverse proxies,
  DNS, and anything else pinned to it keep working across a Force Update) is this plugin's
  central design goal.
- It has no equivalent of the Extra Parameters path — every primary network goes through
  `docker network connect`, whereas this plugin uses Docker's advanced `--network` syntax for
  user-defined primaries, which additionally supports MAC on the additional network.
- It doesn't inject into the Add/Update Container form — additional networks are set up in its
  own page, separately from the rest of a container's configuration. This plugin adds a section
  directly into that form.

If you don't need a persisted fixed IP or in-form editing, Docker Networks may suit you fine —
this plugin exists because both of those were missing pieces for the container this was built
against.

## Verified live

Tested end to end against a real container (`terrible-butler`, primary `bridge`) on the
development host: **Save** wrote the `docker network connect` block into the template,
dockerMan's own Force Update mechanism (`rebuild_container`) recreated the container using it
with zero manual steps, and both the primary network and the additional network (at its fixed
IP) came back automatically — confirmed via `docker inspect`, and via the reverse-proxied site
staying reachable (HTTP 200) through the recreate and a subsequent stop/start cycle. See
`CLAUDE.md` "Live verification" for the full trace.

## Limitations

- `docker network connect` (the Post Arguments path) has no MAC option — MAC on an additional
  network only works on the Extra Parameters path, and only against networks whose driver
  supports assigning one (bridge does; ipvlan does not — confirmed against a real ipvlan
  network, see `CLAUDE.md`).
- The Post Arguments path is incompatible with this plugin's Tailscale integration if the
  container also has Tailscale enabled: dockerMan's own Tailscale handling splits Post
  Arguments at the first `;` for its own purposes. Not handled here — avoid combining the two
  until it is.
- Uninstalling the plugin does **not** touch existing templates — any additional-network
  fragment already written into Extra Parameters/Post Arguments keeps taking effect on its own,
  by design (see `docker.netman.plg`'s remove block).

## Install

Plugins → Install Plugin →
`https://raw.githubusercontent.com/kmbrimble/unraid-docker-netman/main/docker.netman.plg`

Upgrading from the old `unraid-multinet` name: uninstall it first (Plugins → Docker NetMan
formerly unraid-multinet → Remove), then install from the URL above — the install script
migrates `state.json` automatically if it finds the old one; your templates need no changes at
all (the ExtraParams/PostArgs blocks they carry don't reference the plugin's name).

## Development

`php tests/run.php` (server-side parse/serialize/XML-write library) and
`node tests/js.test.js` (the same design's client-side JS twin, shared between the browser
injector and node via `plugin/docker-netman-core.js`'s UMD wrapper). `scripts/build-plugin.sh`
packages a release; see its header for the manual steps after.

See `CLAUDE.md` for the full design record, verified host facts, and standing constraints.
