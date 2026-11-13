<?php
/**
 * Subprocess "web:" tests for plugin/include/api.php. api.php exit()s and declares top-level functions, so it
 * cannot be require'd twice: each call runs it in its own `php` child, with REQUEST_METHOD/$_POST set by a
 * bootstrap, NETMAN_STATE_PATH / NETMAN_TEMPLATES_DIR pointing at a temp tree, and a fake `docker` first on PATH.
 * Included by tests/run.php (uses its check()/checkEquals()).
 */

$webRoot = sys_get_temp_dir() . '/netman-web-' . bin2hex(random_bytes(6));
mkdir("$webRoot/bin", 0777, true);
mkdir("$webRoot/templates", 0777, true);
$webLog = "$webRoot/docker.log";
touch($webLog);

// A fake docker. Containers: alpha (running, has a template, primary br0 ipvlan), beta (stopped, no template).
// Networks: bridge, br0 (ipvlan), proxynet (bridge, has member alpha), spare (bridge, empty).
file_put_contents("$webRoot/bin/docker", <<<'SH'
#!/bin/bash
echo "$*" >> "$FAKE_DOCKER_LOG"
net_json() {
  case "$1" in
    proxynet) echo '{"Name":"proxynet","Driver":"bridge","Internal":false,"IPAM":{"Config":[{"Subnet":"172.18.0.0/16","Gateway":"172.18.0.1"}]},"Containers":{"x":{"Name":"alpha","IPv4Address":"172.18.0.4/16","MacAddress":"02:42:ac:12:00:04"}}}' ;;
    br0) echo '{"Name":"br0","Driver":"ipvlan","Internal":false,"IPAM":{"Config":[]},"Containers":{}}' ;;
    bridge|spare) echo "{\"Name\":\"$1\",\"Driver\":\"bridge\",\"Internal\":false,\"IPAM\":{\"Config\":[]},\"Containers\":{}}" ;;
    *) exit 1 ;;
  esac
}
case "$1 $2" in
  "network ls") printf 'spare\nproxynet\nBridge-x\nbridge\n' | grep -v Bridge-x ;;
  "network inspect")
    if [ "$5" = '{{.Driver}}' ]; then net_json "$3" | sed -E 's/.*"Driver":"([a-z]+)".*/\1/'; else net_json "$3"; fi ;;
  "ps -a") printf 'alpha\trunning\nbeta\texited\n' ;;
  "inspect alpha")
    if [ "$4" = '{{.State.Running}}' ]; then echo true; else echo '{"br0":{"IPAddress":"192.168.0.50","MacAddress":""}}'; fi ;;
  "inspect beta") echo false ;;
  "inspect --type") echo bridge ;;
  "network connect"|"network disconnect"|"network create"|"network rm") exit 0 ;;
  *) exit 0 ;;
esac
SH);
chmod("$webRoot/bin/docker", 0755);

$alphaTpl = '<?xml version="1.0"?><Container version="2"><Name>alpha</Name><Repository>img/alpha</Repository>'
    . '<Network>br0</Network><MyIP></MyIP><MyMAC></MyMAC><ExtraParams>--dns=1.1.1.1</ExtraParams><PostArgs></PostArgs></Container>';
file_put_contents("$webRoot/templates/my-alpha.xml", $alphaTpl);

/** Run plugin/include/api.php in a child. Returns [decoded JSON|null, raw stdout, stderr]. */
function web_call(array $post, string $method = 'POST'): array
{
    global $webRoot, $webLog;
    $boot = "$webRoot/boot-" . bin2hex(random_bytes(4)) . '.php';
    file_put_contents($boot, "<?php\n\$_SERVER['REQUEST_METHOD'] = " . var_export($method, true) . ";\n\$_POST = "
        . var_export($post, true) . ";\nrequire " . var_export(realpath(__DIR__ . '/../plugin/include/api.php'), true) . ";\n");
    $env = [
        'PATH' => "$webRoot/bin:" . getenv('PATH'),
        'NETMAN_STATE_PATH' => "$webRoot/state.json",
        'NETMAN_TEMPLATES_DIR' => "$webRoot/templates",
        'FAKE_DOCKER_LOG' => $webLog,
    ];
    $proc = proc_open(['php', $boot], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env);
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    foreach ($pipes as $p) {
        fclose($p);
    }
    proc_close($proc);
    unlink($boot);
    return [json_decode($out, true), $out, $err];
}

function web_dockerlog(): string
{
    global $webLog;
    return (string) file_get_contents($webLog);
}

// ---- gatekeeping --------------------------------------------------------
[$j, $raw] = web_call(['action' => 'networks'], 'GET');
check('web: a GET is refused with a JSON error and no network listing', is_array($j) && $j['ok'] === false && !isset($j['networks']) && str_contains($j['error'], 'POST'));
check('web: a refused GET never reached docker', web_dockerlog() === '');
[$j] = web_call(['action' => 'frobnicate']);
check('web: unknown action is a JSON error', is_array($j) && $j['ok'] === false && $j['error'] === 'unknown action');
[$j] = web_call([]);
check('web: no action is a JSON error', is_array($j) && $j['ok'] === false);

// ---- networks -----------------------------------------------------------
[$j] = web_call(['action' => 'networks']);
check('web: networks returns ok + list', is_array($j) && $j['ok'] === true && is_array($j['networks']));
checkEquals('web: networks sorted case-insensitively', ['bridge', 'proxynet', 'spare'], array_column($j['networks'] ?? [], 'name'));
$pn = array_values(array_filter($j['networks'] ?? [], fn($n) => $n['name'] === 'proxynet'))[0] ?? [];
checkEquals('web: network shape (driver)', 'bridge', $pn['driver'] ?? null);
checkEquals('web: network shape (subnet)', '172.18.0.0/16', $pn['subnets'][0]['subnet'] ?? null);
checkEquals('web: network shape (member ip, mask stripped)', ['name' => 'alpha', 'ip' => '172.18.0.4', 'mac' => '02:42:ac:12:00:04'], $pn['containers'][0] ?? null);

// ---- network_create / network_delete --------------------------------------
[$j] = web_call(['action' => 'network_create', 'name' => 'bad name!', 'driver' => 'bridge']);
check('web: network_create rejects an invalid name', $j['ok'] === false && $j['error'] === 'invalid network name');
[$j] = web_call(['action' => 'network_create', 'name' => 'br0', 'driver' => 'bridge']);
check('web: network_create rejects a reserved name', $j['ok'] === false && $j['error'] === 'that name is reserved');
check('web: rejected creates never reached docker', !str_contains(web_dockerlog(), 'network create'));
[$j] = web_call(['action' => 'network_create', 'name' => 'scratch', 'driver' => 'bridge', 'subnet' => '172.30.0.0/24', 'internal' => '1']);
check('web: network_create ok', $j['ok'] === true && $j['error'] === null);
check('web: network_create passes subnet and --internal to docker', str_contains(web_dockerlog(), 'network create --driver bridge --subnet 172.30.0.0/24 --internal -- scratch'));
[$j] = web_call(['action' => 'network_delete', 'name' => 'bridge']);
check('web: network_delete refuses a reserved network', $j['ok'] === false && str_contains($j['error'], 'reserved'));
[$j] = web_call(['action' => 'network_delete', 'name' => 'proxynet']);
check('web: network_delete refuses a network with containers attached', $j['ok'] === false && str_contains($j['error'], 'containers still attached'));
check('web: refused deletes never ran docker network rm', !str_contains(web_dockerlog(), 'network rm'));
[$j] = web_call(['action' => 'network_delete', 'name' => 'spare']);
check('web: network_delete removes an empty network', $j['ok'] === true && str_contains(web_dockerlog(), 'network rm -- spare'));

// ---- containers / get / preview ----------------------------------------------
[$j] = web_call(['action' => 'containers']);
check('web: containers ok', is_array($j) && $j['ok'] === true && is_array($j['containers']));
checkEquals('web: containers (template-less container listed read-only, sorted)', ['alpha', 'beta'], array_column($j['containers'] ?? [], 'name'));
$a = $j['containers'][0] ?? [];
foreach (['name', 'primary', 'primary_ip', 'primary_mac', 'primary_mac_supported', 'path', 'rows', 'manually_managed', 'running', 'live_networks', 'installed', 'no_template'] as $k) {
    check("web: container summary has '$k'", array_key_exists($k, $a));
}
checkEquals('web: alpha path is extra (primary br0)', 'extra', $a['path'] ?? null);
check('web: alpha is running and installed with a template', ($a['running'] ?? null) === true && ($a['installed'] ?? null) === true && ($a['no_template'] ?? null) === false);
checkEquals('web: alpha live networks', ['br0' => ['ip' => '192.168.0.50', 'mac' => '']], $a['live_networks'] ?? null);
check('web: ipvlan primary means MAC unsupported', ($a['primary_mac_supported'] ?? null) === false);
$b = $j['containers'][1] ?? [];
check('web: beta is no_template, rows empty, not running', ($b['no_template'] ?? null) === true && ($b['rows'] ?? null) === [] && ($b['running'] ?? null) === false);

[$j] = web_call(['action' => 'get', 'name' => 'alpha']);
check('web: get returns the container summary', $j['ok'] === true && $j['container']['name'] === 'alpha');
[$j] = web_call(['action' => 'get', 'name' => 'nope']);
check('web: get of a missing template is a JSON error', $j['ok'] === false && $j['error'] === 'no template for that container');

[$j] = web_call(['action' => 'preview', 'primary' => 'br0', 'name' => 'alpha', 'rows' => json_encode([['network' => 'proxynet', 'ip' => '172.18.0.9', 'alias' => null, 'mac' => null]])]);
checkEquals('web: preview (extra path)', ['ok' => true, 'path' => 'extra', 'fragment' => '--network br0 --network name=proxynet,ip=172.18.0.9'], $j);
[$j] = web_call(['action' => 'preview', 'primary' => 'bridge', 'name' => 'alpha', 'rows' => json_encode([['network' => 'proxynet', 'ip' => null, 'alias' => null, 'mac' => null]])]);
check('web: preview (post path) chains docker network connect', $j['ok'] === true && $j['path'] === 'post' && str_starts_with($j['fragment'], '&& docker network connect'));

// ---- save ------------------------------------------------------------------------
[$j] = web_call(['action' => 'save', 'name' => 'alpha', 'rows' => json_encode([['network' => 'bridge', 'ip' => null, 'alias' => null, 'mac' => null]])]);
check('web: save rejects a reserved additional network', $j['ok'] === false && str_contains($j['error'], 'invalid additional network'));
[$j] = web_call(['action' => 'save', 'name' => 'ghost', 'rows' => '[]']);
check('web: save with no template is a JSON error', $j['ok'] === false && $j['error'] === 'no template for that container');
check('web: nothing written yet', !file_exists("$webRoot/state.json") && file_get_contents("$webRoot/templates/my-alpha.xml") === $alphaTpl);

$rows = [['network' => 'proxynet', 'ip' => '172.18.0.5', 'alias' => 'a', 'mac' => null]];
[$j] = web_call(['action' => 'save', 'name' => 'alpha', 'rows' => json_encode($rows)]);
checkEquals('web: save ok on the extra path', ['ok' => true, 'path' => 'extra'], $j);
$tplAfter = (string) file_get_contents("$webRoot/templates/my-alpha.xml");
check('web: save wrote the block into ExtraParams and nothing else changed',
    $tplAfter === str_replace('--dns=1.1.1.1', '--dns=1.1.1.1 --network br0 --network name=proxynet,ip=172.18.0.5,alias=a', $alphaTpl));
$st = json_decode((string) @file_get_contents("$webRoot/state.json"), true);
checkEquals('web: save recorded the rows in state.json', $rows, $st['alpha']['rows'] ?? null);
[$j] = web_call(['action' => 'containers']);
check('web: after save, alpha lists the saved row and is not manually managed', ($j['containers'][0]['rows'][0]['network'] ?? null) === 'proxynet' && $j['containers'][0]['manually_managed'] === false);

// ---- manually managed: hand-written block, no state -----------------------------------
$hand = str_replace('--dns=1.1.1.1', '--dns=1.1.1.1 --network br0 --network name=proxynet,ip=172.18.0.77', $alphaTpl);
file_put_contents("$webRoot/templates/my-alpha.xml", $hand);
unlink("$webRoot/state.json");
[$j] = web_call(['action' => 'containers']);
check('web: a hand-written block with no record reads as manually managed', $j['containers'][0]['manually_managed'] === true);
[$j] = web_call(['action' => 'save', 'name' => 'alpha', 'rows' => '[]']);
check('web: save refuses to rewrite a manually managed block', $j['ok'] === false && ($j['manually_managed'] ?? false) === true);
check('web: the refused save left the template byte-identical', file_get_contents("$webRoot/templates/my-alpha.xml") === $hand);
[$j] = web_call(['action' => 'adopt', 'name' => 'alpha', 'dry_run' => '1']);
check('web: adopt dry_run reports a plan', $j['ok'] === true && isset($j['mode'], $j['field'], $j['before']) && !isset($j['state']));
check('web: adopt dry_run changed nothing', file_get_contents("$webRoot/templates/my-alpha.xml") === $hand && !file_exists("$webRoot/state.json"));
[$j] = web_call(['action' => 'adopt', 'name' => 'alpha']);
check('web: adopt records the block in state.json', $j['ok'] === true && is_file("$webRoot/state.json") && !isset($j['state']));
[$j] = web_call(['action' => 'adopt', 'name' => 'ghost']);
check('web: adopt with no template is a JSON refusal', $j['ok'] === false && $j['mode'] === 'refuse');
[$j] = web_call(['action' => 'containers']);
check('web: after adopt the container is no longer manually managed', $j['containers'][0]['manually_managed'] === false);

// ---- apply -----------------------------------------------------------------------------
[$j] = web_call(['action' => 'apply', 'name' => 'ghost']);
check('web: apply with no template is a JSON error', $j['ok'] === false && $j['error'] === 'no template for that container');
file_put_contents($webLog, '');
[$j] = web_call(['action' => 'apply', 'name' => 'alpha']);
check('web: apply returns an actions list', is_array($j) && isset($j['actions']) && is_array($j['actions']));
check('web: apply connects the missing desired network', in_array(['op' => 'connect', 'network' => 'proxynet', 'ok' => true, 'error' => null], $j['actions'] ?? [], true)
    && str_contains(web_dockerlog(), 'network connect --ip 172.18.0.77 -- proxynet alpha'));

// ---- no web-reachable file may use STDOUT/STDERR/$argv ---------------------------------------
foreach (['api.php', 'netman.php', 'docker.php'] as $f) {
    $src = file_get_contents(__DIR__ . '/../plugin/include/' . $f);
    check("web: $f does not use STDOUT/STDERR/\$argv (undefined under php-fpm)", !preg_match('/\b(STDOUT|STDERR|STDIN)\b|\$argv\b/', $src));
}

// cleanup
foreach (glob("$webRoot/templates/*") ?: [] as $f) { @unlink($f); }
foreach (glob("$webRoot/bin/*") ?: [] as $f) { @unlink($f); }
foreach (glob("$webRoot/*.*") ?: [] as $f) { @unlink($f); }
@rmdir("$webRoot/templates"); @rmdir("$webRoot/bin"); @rmdir($webRoot);
