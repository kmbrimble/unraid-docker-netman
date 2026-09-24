<?php
declare(strict_types=1);

require_once __DIR__ . '/../plugin/include/netman.php';

$failures = 0;
$count = 0;

function check(string $name, bool $cond): void
{
    global $failures, $count;
    $count++;
    if (!$cond) {
        $failures++;
        echo "FAIL: $name\n";
    }
}

function checkEquals(string $name, $expected, $actual): void
{
    check($name . " (expected " . var_export($expected, true) . ", got " . var_export($actual, true) . ")", $expected === $actual);
}

// ---- ExtraParams path round-trip --------------------------------------

$rows = [
    ['network' => 'proxynet', 'ip' => '172.18.0.5', 'alias' => 'foo', 'mac' => null],
    ['network' => 'other', 'ip' => null, 'alias' => null, 'mac' => null],
];
$run = netman_build_network_run('br0', $rows, null, false);
checkEquals('extra: build run', '--network br0 --network name=proxynet,ip=172.18.0.5,alias=foo --network name=other', $run);

$extraParams = netman_serialize_extra('--dns=1.1.1.1', $run);
checkEquals('extra: serialize with existing remaining', "--dns=1.1.1.1 --network br0 --network name=proxynet,ip=172.18.0.5,alias=foo --network name=other", $extraParams);

$parsed = netman_parse_extra($extraParams, 'br0', $rows);
check('extra: found', $parsed['found']);
check('extra: not manually managed (matches state)', !$parsed['manually_managed']);
checkEquals('extra: remaining preserved', '--dns=1.1.1.1', $parsed['remaining']);
check('extra: rows round-trip', netman_rows_equal($parsed['rows'], $rows));

// re-serialize what we parsed and parse again -> identical
$run2 = netman_build_network_run('br0', $parsed['rows'], $parsed['primary_mac'], false);
$extraParams2 = netman_serialize_extra($parsed['remaining'], $run2);
checkEquals('extra: idempotent serialize', $extraParams, $extraParams2);
$parsed2 = netman_parse_extra($extraParams2, 'br0', $rows);
check('extra: idempotent parse', netman_rows_equal($parsed2['rows'], $rows));

// ---- ExtraParams path: primary-with-MAC (fact 3) -----------------------

$macRun = netman_build_network_run('proxynet', [], '02:11:22:33:44:55', true);
checkEquals('mac: primary carries mac-address', '--network name=proxynet,mac-address=02:11:22:33:44:55', $macRun);
$macParsed = netman_parse_extra($macRun, 'proxynet', []);
checkEquals('mac: parsed back out', '02:11:22:33:44:55', $macParsed['primary_mac']);

// ipvlan/macvlan primaries don't support mac-address at all (live-probed,
// see CLAUDE.md) — caller must pass primarySupportsMac=false, and the mac
// is then silently dropped rather than emitted (would fail docker run).
$noMacRun = netman_build_network_run('br0', [], '02:11:22:33:44:55', false);
checkEquals('mac: dropped when primary does not support it', '--network br0', $noMacRun);

// ---- ExtraParams path: manually-managed refusal -------------------------

$foreign = '--network br0 --network name=other,ip=10.0.0.5';
$parsedForeign = netman_parse_extra($foreign, 'br0', []); // no state.json entry recorded
check('manually-managed: no state entry + found block -> refuse', $parsedForeign['manually_managed']);

$knownRows = [['network' => 'proxynet', 'ip' => '172.18.0.9', 'alias' => null, 'mac' => null]];
$known = netman_build_network_run('br0', $knownRows, null, false);
$parsedKnown = netman_parse_extra($known, 'br0', $knownRows);
check('manually-managed: matches state -> trusted', !$parsedKnown['manually_managed']);

$driftedExpected = [['network' => 'proxynet', 'ip' => '172.18.0.99', 'alias' => null, 'mac' => null]];
$parsedDrifted = netman_parse_extra($known, 'br0', $driftedExpected);
check('manually-managed: drift from state -> refuse', $parsedDrifted['manually_managed']);

// ---- PostArgs path round-trip -------------------------------------------

$postRows = [
    ['network' => 'proxynet', 'ip' => '172.18.0.3', 'alias' => 'butler', 'mac' => null],
];
$chain = netman_build_connect_chain('terrible-butler', $postRows);
checkEquals('post: build chain', 'docker network connect --ip 172.18.0.3 --alias butler proxynet terrible-butler', $chain);

$postArgs = netman_serialize_post('', $chain);
checkEquals('post: serialize with empty remaining', '&& docker network connect --ip 172.18.0.3 --alias butler proxynet terrible-butler', $postArgs);

$parsedPost = netman_parse_post($postArgs, 'terrible-butler', $postRows);
check('post: found', $parsedPost['found']);
check('post: not manually managed', !$parsedPost['manually_managed']);
checkEquals('post: remaining empty', '', $parsedPost['remaining']);
check('post: rows round-trip', netman_rows_equal($parsedPost['rows'], $postRows));

// PostArgs with pre-existing user args (§34: our block is appended AFTER
// whatever the user already has, chained with &&).
$userPostArgs = '--foo bar --baz';
$combined = netman_serialize_post($userPostArgs, $chain);
checkEquals('post: appended after existing user args', '--foo bar --baz && docker network connect --ip 172.18.0.3 --alias butler proxynet terrible-butler', $combined);
$parsedCombined = netman_parse_post($combined, 'terrible-butler', $postRows);
checkEquals('post: user args preserved verbatim', $userPostArgs, $parsedCombined['remaining']);
check('post: rows still round-trip with user args present', netman_rows_equal($parsedCombined['rows'], $postRows));

// idempotent re-serialize
$chain2 = netman_build_connect_chain('terrible-butler', $parsedCombined['rows']);
$combined2 = netman_serialize_post($parsedCombined['remaining'], $chain2);
checkEquals('post: idempotent serialize', $combined, $combined2);

// ---- PostArgs manually-managed refusal ----------------------------------

$foreignPost = 'docker network connect --ip 10.0.0.5 othernet terrible-butler';
$parsedForeignPost = netman_parse_post($foreignPost, 'terrible-butler', []);
check('post manually-managed: no state entry -> refuse', $parsedForeignPost['manually_managed']);

// ---- IP validation -------------------------------------------------------

check('ip in subnet', netman_ip_in_subnet('172.18.0.5', '172.18.0.0/16'));
check('ip not in subnet', !netman_ip_in_subnet('10.0.0.5', '172.18.0.0/16'));
check('ip in subnet /24', netman_ip_in_subnet('172.18.0.254', '172.18.0.0/24'));
check('ip outside /24', !netman_ip_in_subnet('172.18.1.1', '172.18.0.0/24'));

// ---- XML template write preserves everything else -----------------------

$tmpXml = sys_get_temp_dir() . '/netman-test-' . getmypid() . '.xml';
file_put_contents($tmpXml, <<<XML
<?xml version="1.0"?>
<Container version="2">
  <Name>terrible-butler</Name>
  <Network>bridge</Network>
  <ExtraParams/>
  <PostArgs>--foo bar</PostArgs>
  <Overview>Household inventory tracking app, unRAID managed.</Overview>
</Container>
XML
);

$ok = netman_write_template_field($tmpXml, 'PostArgs', '--foo bar && docker network connect --ip 172.18.0.3 proxynet terrible-butler');
check('xml write: reports success', $ok);
$after = file_get_contents($tmpXml);
check('xml write: PostArgs updated', str_contains($after, '<PostArgs>--foo bar &amp;&amp; docker network connect --ip 172.18.0.3 proxynet terrible-butler</PostArgs>'));
check('xml write: Name untouched', str_contains($after, '<Name>terrible-butler</Name>'));
check('xml write: Overview untouched', str_contains($after, '<Overview>Household inventory tracking app, unRAID managed.</Overview>'));
check('xml write: still valid xml', @simplexml_load_file($tmpXml) !== false);

$ok2 = netman_write_template_field($tmpXml, 'ExtraParams', '');
check('xml write: empty value uses self-closing tag', $ok2);
check('xml write: self-closing ExtraParams', str_contains(file_get_contents($tmpXml), '<ExtraParams/>'));

unlink($tmpXml);

// ---- path selection -------------------------------------------------------

checkEquals('path: bridge -> post', 'post', netman_choose_path('bridge'));
checkEquals('path: host -> post', 'post', netman_choose_path('host'));
checkEquals('path: none -> post', 'post', netman_choose_path('none'));
checkEquals('path: container:x -> post', 'post', netman_choose_path('container:other'));
checkEquals('path: br0 -> extra', 'extra', netman_choose_path('br0'));
checkEquals('path: proxynet -> extra', 'extra', netman_choose_path('proxynet'));

// ---- container/template join + case-insensitive sort -----------------------

$tpls = ['Immich' => '/t/my-Immich.xml', 'immich-machine-learning' => '/t/a.xml', 'Immich-machine-learning' => '/t/b.xml', 'ollama' => '/t/o.xml'];
$names = ['terrible-butler', 'AdGuardHome', 'claude-code', 'Immich', 'Immich-machine-learning', 'unraid-ops-x'];
$j = netman_join_containers($names, $tpls, false);
checkEquals('join: default order is case-insensitive', ['AdGuardHome', 'claude-code', 'Immich', 'Immich-machine-learning', 'terrible-butler', 'unraid-ops-x'], array_column($j, 'name'));
$by = array_column($j, null, 'name');
checkEquals('join: exists+template has path', '/t/my-Immich.xml', $by['Immich']['path']);
checkEquals('join: exists, no template -> null path', null, $by['unraid-ops-x']['path']);
check('join: all default entries installed', !in_array(false, array_column($j, 'installed'), true));
check('join: previous apps hidden by default', !isset($by['ollama']) && !isset($by['immich-machine-learning']));
$jp = netman_join_containers($names, $tpls, true);
$byp = array_column($jp, null, 'name');
check('join: template-no-container included when asked', isset($byp['ollama']) && $byp['ollama']['installed'] === false);
check('join: exact-name match is case-sensitive (stale lowercase is previous)', $byp['immich-machine-learning']['installed'] === false && $byp['Immich-machine-learning']['installed'] === true);
checkEquals('join: previous apps sorted in with the rest', ['AdGuardHome', 'claude-code', 'Immich', 'Immich-machine-learning', 'immich-machine-learning', 'ollama', 'terrible-butler', 'unraid-ops-x'], array_column($jp, 'name'));

// ---- adopt ------------------------------------------------------------------

function adoptTpl(string $extra, string $post): string
{
    $p = sys_get_temp_dir() . '/netman-adopt-' . getmypid() . '-' . mt_rand() . '.xml';
    file_put_contents($p, "<?xml version=\"1.0\"?>\n<Container version=\"2\">\n  <Name>Grafana</Name>\n  <Network>bridge</Network>\n  <ExtraParams>" . netman_xml_encode($extra) . "</ExtraParams>\n  <PostArgs>" . netman_xml_encode($post) . "</PostArgs>\n</Container>\n");
    return $p;
}
$userArg = '--user "$(id -u)"';

// exact canonical block: state only, template bytes untouched
$canon = '&& docker network connect proxynet Grafana';
$tp = adoptTpl($userArg, $canon);
$before = file_get_contents($tp);
$r = netman_adopt('Grafana', 'bridge', $canon, $tp, [], false);
checkEquals('adopt exact: mode', 'state_only', $r['mode']);
check('adopt exact: template untouched', file_get_contents($tp) === $before);
checkEquals('adopt exact: state rows', [['network' => 'proxynet', 'ip' => null, 'alias' => null, 'mac' => null]], $r['state']['Grafana']['rows']);
$after = netman_parse_post($canon, 'Grafana', $r['state']['Grafana']['rows']);
check('adopt exact: no longer manually managed afterwards', !$after['manually_managed']);
$d = netman_adopt('Grafana', 'bridge', $canon, $tp, [], true);
check('adopt dry-run: state not changed', $d['state'] === []);
check('adopt already-managed refused', !netman_adopt('Grafana', 'bridge', $canon, $tp, $r['state'], true)['ok']);
unlink($tp);

// needs normalisation: ';' separator and extra whitespace; only PostArgs is rewritten, ExtraParams survives byte-for-byte
$odd = '; docker  network connect   --alias web proxynet Grafana';
$tp = adoptTpl($userArg, $odd);
$before2 = file_get_contents($tp);
$r = netman_adopt('Grafana', 'bridge', $odd, $tp, [], true);
checkEquals('adopt normalise: mode', 'normalise', $r['mode']);
checkEquals('adopt normalise: after text', '&& docker network connect --alias web proxynet Grafana', $r['after']);
check('adopt normalise dry-run: template untouched', file_get_contents($tp) === $before2);
$r = netman_adopt('Grafana', 'bridge', $odd, $tp, [], false);
$x = simplexml_load_file($tp);
checkEquals('adopt normalise: PostArgs rewritten', '&& docker network connect --alias web proxynet Grafana', (string) $x->PostArgs);
checkEquals('adopt normalise: ExtraParams byte-for-byte', $userArg, (string) $x->ExtraParams);
check('adopt normalise: ExtraParams raw text identical', strpos(file_get_contents($tp), '<ExtraParams>' . netman_xml_encode($userArg) . '</ExtraParams>') !== false);
unlink($tp);

// unparseable: unknown flag / other container -> refuse, template untouched
foreach (['&& docker network connect --ip=1.2.3.4 proxynet Grafana', '&& docker network connect proxynet Other', '&& docker network connect --driver-opt x=y proxynet Grafana'] as $bad) {
    $tp = adoptTpl($userArg, $bad);
    $b = file_get_contents($tp);
    $r = netman_adopt('Grafana', 'bridge', $bad, $tp, [], false);
    check("adopt refuses: $bad", !$r['ok'] && $r['mode'] === 'refuse' && file_get_contents($tp) === $b);
    unlink($tp);
}
// half-parseable: a good chunk followed by an unknown one must refuse too
$half = '&& docker network connect proxynet Grafana && docker network connect --weird x Grafana';
check('adopt refuses half-parseable chain', !netman_adopt('Grafana', 'bridge', $half, '/nonexistent', [], false)['ok']);
// extra path: user network primary, hand-written --network run
$ex = '--network br0 --network name=proxynet,ip=172.18.0.9 --dns=1.1.1.1';
$r = netman_adopt('Grafana', 'br0', $ex, '/nonexistent', [], true);
checkEquals('adopt extra: normalise (remaining moved before run)', 'normalise', $r['mode']);
$ex2 = '--network br0 --network name=proxynet,ip=172.18.0.9';
checkEquals('adopt extra exact: state_only', 'state_only', netman_adopt('Grafana', 'br0', $ex2, '/nonexistent', [], true)['mode']);
check('adopt extra refuses unknown --network form', !netman_adopt('Grafana', 'br0', '--network br0 --network=proxynet', '/nonexistent', [], true)['ok']);

// ---- summary ---------------------------------------------------------

echo "\n$count checks, $failures failures\n";
exit($failures === 0 ? 0 : 1);
