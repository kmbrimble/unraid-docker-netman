<?php
/**
 * Docker NetMan — pure library. No side effects at include time.
 *
 * Serialization design (see docs/SPEC.md "Serialization design" for the
 * full rationale — this implements it as written, do not relitigate it
 * here):
 *
 * - A container's additional networks live ONLY in its template, inside
 *   ExtraParams (primary is a user-defined network) or PostArgs (primary
 *   is bridge/host/none/container:*) — never both.
 * - /boot/config/plugins/docker.netman/state.json is a sidecar recording
 *   what THIS plugin last wrote per container, used only to tell "our
 *   block" apart from something the user typed by hand. The template is
 *   always re-parsed as truth; state.json only disambiguates.
 * - If a --network run (ExtraParams path) or docker-network-connect chain
 *   (PostArgs path) is found in the template that does not match what
 *   state.json says we wrote, the container is "manually managed": the
 *   library refuses to rewrite that field and the caller must fall back
 *   to (or offer) the other path.
 *
 * Row shape used throughout: ['network' => str, 'ip' => ?str,
 * 'alias' => ?str, 'mac' => ?str].
 */

const NETMAN_STATE_PATH = '/boot/config/plugins/docker.netman/state.json';

/** Networks that can never be an "additional network" target. */
function netman_reserved_networks(): array
{
    return ['bridge', 'host', 'none'];
}

/**
 * Split a string into shell-like tokens, keeping quoted segments (single
 * or double) intact as one token with quotes stripped. Good enough for
 * parsing fragments this plugin itself wrote (which never need nested
 * quoting) and for finding token boundaries in arbitrary user text.
 */
function netman_tokenize(string $s): array
{
    $tokens = [];
    $len = strlen($s);
    $i = 0;
    while ($i < $len) {
        while ($i < $len && ctype_space($s[$i])) {
            $i++;
        }
        if ($i >= $len) {
            break;
        }
        $tok = '';
        while ($i < $len && !ctype_space($s[$i])) {
            $c = $s[$i];
            if ($c === '"' || $c === "'") {
                $q = $c;
                $i++;
                while ($i < $len && $s[$i] !== $q) {
                    $tok .= $s[$i];
                    $i++;
                }
                $i++; // skip closing quote
            } else {
                $tok .= $c;
                $i++;
            }
        }
        $tokens[] = $tok;
    }
    return $tokens;
}

function netman_is_network_flag(string $tok): bool
{
    return $tok === '--network' || $tok === '--net';
}

/** name=X[,ip=Y][,alias=Z][,mac-address=W] -> ['network'=>X, ...] (missing keys omitted). */
function netman_parse_advanced_value(string $value): array
{
    $out = [];
    foreach (explode(',', $value) as $kv) {
        if (strpos($kv, '=') === false) {
            if (!isset($out['network'])) {
                $out['network'] = $kv; // bare short form, e.g. "br0"
            }
            continue;
        }
        [$k, $v] = explode('=', $kv, 2);
        switch ($k) {
            case 'name':
                $out['network'] = $v;
                break;
            case 'ip':
                $out['ip'] = $v;
                break;
            case 'alias':
                $out['alias'] = $v;
                break;
            case 'mac-address':
                $out['mac'] = $v;
                break;
        }
    }
    return $out;
}

function netman_row_defaults(array $row): array
{
    return [
        'network' => $row['network'] ?? '',
        'ip' => $row['ip'] ?? null,
        'alias' => $row['alias'] ?? null,
        'mac' => $row['mac'] ?? null,
    ];
}

function netman_rows_equal(array $a, array $b): bool
{
    if (count($a) !== count($b)) {
        return false;
    }
    foreach ($a as $i => $rowA) {
        $rowB = $b[$i] ?? null;
        if ($rowB === null) {
            return false;
        }
        $rowA = netman_row_defaults($rowA);
        $rowB = netman_row_defaults($rowB);
        if ($rowA !== $rowB) {
            return false;
        }
    }
    return true;
}

/**
 * Decide which path applies for a given primary network.
 * bridge/host/none/container:* -> PostArgs. Anything else (a user-defined
 * bridge/ipvlan/macvlan network, e.g. br0, br0.66, proxynet) -> ExtraParams.
 */
function netman_choose_path(string $primary): string
{
    if ($primary === 'bridge' || $primary === 'host' || $primary === 'none' || str_starts_with($primary, 'container:')) {
        return 'post';
    }
    return 'extra';
}

/**
 * Parse the ExtraParams field. Returns:
 *   ['remaining' => string, 'primary_mac' => ?string, 'rows' => array,
 *    'found' => bool, 'manually_managed' => bool]
 * $expected is the state.json rows list for this container (or [] if none
 * on record), used only to tell "our block" apart from a hand-written one.
 */
function netman_parse_extra(string $extraParams, string $primary, array $expected): array
{
    $tokens = netman_tokenize($extraParams);
    $n = count($tokens);

    $startIdx = null;
    $primaryMac = null;
    for ($i = 0; $i < $n - 1; $i++) {
        if (!netman_is_network_flag($tokens[$i])) {
            continue;
        }
        $val = $tokens[$i + 1];
        if ($val === $primary) {
            $startIdx = $i;
            break;
        }
        $parsed = netman_parse_advanced_value($val);
        if (($parsed['network'] ?? null) === $primary) {
            $startIdx = $i;
            $primaryMac = $parsed['mac'] ?? null;
            break;
        }
    }

    if ($startIdx === null) {
        return [
            'remaining' => $extraParams,
            'primary_mac' => null,
            'rows' => [],
            'found' => false,
            'manually_managed' => false,
        ];
    }

    $rows = [];
    $j = $startIdx + 2; // skip the primary's --network + value
    while ($j < $n - 1 && netman_is_network_flag($tokens[$j])) {
        $parsed = netman_parse_advanced_value($tokens[$j + 1]);
        if (!isset($parsed['network'])) {
            break; // malformed — stop the run here, treat rest as remaining
        }
        $rows[] = netman_row_defaults($parsed);
        $j += 2;
    }
    $endIdx = $j; // exclusive

    $remainingTokens = array_merge(
        array_slice($tokens, 0, $startIdx),
        array_slice($tokens, $endIdx)
    );
    $remaining = implode(' ', array_map('netman_shell_quote_if_needed', $remainingTokens));

    $manuallyManaged = !netman_rows_equal($rows, $expected);

    return [
        'remaining' => $remaining,
        'primary_mac' => $primaryMac,
        'rows' => $rows,
        'found' => true,
        'manually_managed' => $manuallyManaged,
    ];
}

function netman_shell_quote_if_needed(string $tok): string
{
    if ($tok === '' || preg_match('/[\s"\']/', $tok)) {
        return "'" . str_replace("'", "'\\''", $tok) . "'";
    }
    return $tok;
}

/**
 * Build the ExtraParams --network run for the primary + additional rows.
 * $primaryMac is the value of the (visible) contMyMAC field — pass null/''
 * if unset. $primarySupportsMac must come from the caller (ipvlan/macvlan
 * primaries don't support it — see docs/SPEC.md fact 3 and the live probe
 * recorded in CLAUDE.md); when false, $primaryMac is ignored.
 */
function netman_build_network_run(string $primary, array $rows, ?string $primaryMac, bool $primarySupportsMac): string
{
    $parts = [];
    if ($primaryMac && $primarySupportsMac) {
        $parts[] = '--network name=' . $primary . ',mac-address=' . $primaryMac;
    } else {
        $parts[] = '--network ' . $primary;
    }
    foreach ($rows as $row) {
        $row = netman_row_defaults($row);
        $kv = ['name=' . $row['network']];
        if (!empty($row['ip'])) {
            $kv[] = 'ip=' . $row['ip'];
        }
        if (!empty($row['alias'])) {
            $kv[] = 'alias=' . $row['alias'];
        }
        if (!empty($row['mac'])) {
            $kv[] = 'mac-address=' . $row['mac'];
        }
        $parts[] = '--network ' . implode(',', $kv);
    }
    return implode(' ', $parts);
}

function netman_serialize_extra(string $remaining, string $networkRun): string
{
    $remaining = trim($remaining);
    return $remaining === '' ? $networkRun : $remaining . ' ' . $networkRun;
}

/**
 * Parse PostArgs for our `&& docker network connect ... <containerName>`
 * chain. Same return shape as netman_parse_extra (no primary_mac — the
 * PostArgs path never carries a MAC, see docs/SPEC.md fact 5/§34).
 */
function netman_parse_post(string $postArgs, string $containerName, array $expected): array
{
    $tokens = netman_tokenize($postArgs);
    $n = count($tokens);

    $chainStart = null;
    for ($i = 0; $i < $n; $i++) {
        if ($tokens[$i] === 'docker' && ($tokens[$i + 1] ?? '') === 'network' && ($tokens[$i + 2] ?? '') === 'connect') {
            // Back up over a leading && / ; / | if present, that's ours to remove too.
            $chainStart = $i;
            if ($i > 0 && in_array($tokens[$i - 1], ['&&', ';', '|'], true)) {
                $chainStart = $i - 1;
            }
            break;
        }
    }

    if ($chainStart === null) {
        return [
            'remaining' => $postArgs,
            'primary_mac' => null,
            'rows' => [],
            'found' => false,
            'manually_managed' => false,
        ];
    }

    $rows = [];
    $j = $chainStart;
    $chainEnd = $chainStart;
    while ($j < $n) {
        if (in_array($tokens[$j], ['&&', ';', '|'], true)) {
            $j++;
        }
        if (($tokens[$j] ?? '') !== 'docker' || ($tokens[$j + 1] ?? '') !== 'network' || ($tokens[$j + 2] ?? '') !== 'connect') {
            break;
        }
        $k = $j + 3;
        $ip = null;
        $alias = null;
        while (isset($tokens[$k]) && str_starts_with($tokens[$k], '--')) {
            if ($tokens[$k] === '--ip') {
                $ip = $tokens[$k + 1] ?? null;
                $k += 2;
            } elseif ($tokens[$k] === '--alias') {
                $alias = $tokens[$k + 1] ?? null;
                $k += 2;
            } else {
                break 2; // unrecognised flag — not a chunk we wrote, stop here
            }
        }
        $net = $tokens[$k] ?? null;
        $ctn = $tokens[$k + 1] ?? null;
        if ($net === null || $ctn !== $containerName) {
            break;
        }
        $rows[] = netman_row_defaults(['network' => $net, 'ip' => $ip, 'alias' => $alias]);
        $chainEnd = $k + 2;
        $j = $chainEnd;
    }

    if (empty($rows)) {
        return [
            'remaining' => $postArgs,
            'primary_mac' => null,
            'rows' => [],
            'found' => false,
            'manually_managed' => false,
        ];
    }

    $remainingTokens = array_merge(
        array_slice($tokens, 0, $chainStart),
        array_slice($tokens, $chainEnd)
    );
    $remaining = implode(' ', array_map('netman_shell_quote_if_needed', $remainingTokens));

    $manuallyManaged = !netman_rows_equal($rows, $expected);

    return [
        'remaining' => $remaining,
        'primary_mac' => null,
        'rows' => $rows,
        'found' => true,
        'manually_managed' => $manuallyManaged,
    ];
}

function netman_build_connect_chain(string $containerName, array $rows): string
{
    $parts = [];
    foreach ($rows as $row) {
        $row = netman_row_defaults($row);
        $cmd = ['docker', 'network', 'connect'];
        if (!empty($row['ip'])) {
            $cmd[] = '--ip';
            $cmd[] = $row['ip'];
        }
        if (!empty($row['alias'])) {
            $cmd[] = '--alias';
            $cmd[] = $row['alias'];
        }
        $cmd[] = $row['network'];
        $cmd[] = $containerName;
        $parts[] = implode(' ', $cmd);
    }
    return implode(' && ', $parts);
}

/**
 * dockerMan appends PostArgs verbatim after the image (they're the
 * container's CMD unless they start with &&/;/|) — see docs/SPEC.md §34.
 * Our chain always goes after whatever the user already has and is
 * prefixed with " && " so it's a no-op if PostArgs was empty, and correct
 * shell chaining if not.
 */
function netman_serialize_post(string $remaining, string $chain): string
{
    $remaining = rtrim($remaining);
    if ($chain === '') {
        return $remaining;
    }
    return $remaining === '' ? '&& ' . $chain : $remaining . ' && ' . $chain;
}

// ---- state.json -----------------------------------------------------

function netman_state_load(): array
{
    if (!is_file(NETMAN_STATE_PATH)) {
        return [];
    }
    $json = file_get_contents(NETMAN_STATE_PATH);
    $data = json_decode($json ?: '{}', true);
    return is_array($data) ? $data : [];
}

function netman_state_save(array $state): void
{
    $dir = dirname(NETMAN_STATE_PATH);
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }
    $tmp = NETMAN_STATE_PATH . '.tmp';
    file_put_contents($tmp, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    rename($tmp, NETMAN_STATE_PATH);
}

function netman_state_get(array $state, string $containerName): array
{
    return $state[$containerName]['rows'] ?? [];
}

function netman_state_set(array $state, string $containerName, string $primary, string $path, array $rows): array
{
    $state[$containerName] = ['primary' => $primary, 'path' => $path, 'rows' => $rows];
    return $state;
}

// ---- template XML I/O -------------------------------------------------

const NETMAN_TEMPLATES_DIR = '/boot/config/plugins/dockerMan/templates-user';

function netman_list_templates(): array
{
    $files = glob(NETMAN_TEMPLATES_DIR . '/my-*.xml') ?: [];
    sort($files);
    return $files;
}

/** Mirrors Helpers.php's xml_encode/xml_decode exactly (ENT_XML1 htmlspecialchars). */
function netman_xml_encode(string $s): string
{
    return htmlspecialchars($s, ENT_XML1, 'UTF-8');
}

function netman_xml_decode(string $s): string
{
    return strval(html_entity_decode($s, ENT_XML1, 'UTF-8'));
}

/** Read a template, return ['xml'=>SimpleXMLElement, 'path'=>str] or null. */
function netman_read_template(string $containerName): ?array
{
    $path = NETMAN_TEMPLATES_DIR . '/my-' . $containerName . '.xml';
    if (!is_file($path)) {
        return null;
    }
    $xml = simplexml_load_file($path);
    if ($xml === false) {
        return null;
    }
    return ['xml' => $xml, 'path' => $path];
}

/**
 * Rewrite ONLY <ExtraParams> or <PostArgs> in the template file, leaving
 * every other element byte-for-byte untouched. Works on the raw text
 * (not a re-serialized SimpleXMLElement) so nothing else in the template
 * can drift.
 */
// ---- validation --------------------------------------------------------

/** True if $ip (dotted IPv4) falls inside $cidr (e.g. "172.18.0.0/16"). */
function netman_ip_in_subnet(string $ip, string $cidr): bool
{
    if (strpos($cidr, '/') === false) {
        return false;
    }
    [$subnet, $bits] = explode('/', $cidr, 2);
    $ipLong = ip2long($ip);
    $subnetLong = ip2long($subnet);
    $bits = (int) $bits;
    if ($ipLong === false || $subnetLong === false || $bits < 0 || $bits > 32) {
        return false;
    }
    $mask = $bits === 0 ? 0 : (-1 << (32 - $bits));
    return ($ipLong & $mask) === ($subnetLong & $mask);
}

function netman_write_template_field(string $path, string $element, string $newValue): bool
{
    $contents = file_get_contents($path);
    if ($contents === false) {
        return false;
    }
    $encoded = netman_xml_encode($newValue);
    $pattern = '#<' . $element . '(\s[^>]*)?(/>|>.*?</' . $element . '>)#s';
    if (!preg_match($pattern, $contents)) {
        return false;
    }
    $replacement = $encoded === '' ? "<$element/>" : "<$element>$encoded</$element>";
    $new = preg_replace($pattern, $replacement, $contents, 1);
    if ($new === null) {
        return false;
    }
    return file_put_contents($path, $new) !== false;
}
