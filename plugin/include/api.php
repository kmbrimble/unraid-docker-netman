<?php
/**
 * unraid-multinet — JSON endpoint for MultiNet.page / MultiNetInject.page.
 *
 * No explicit CSRF check here, deliberately (same as unraid-secretsman's
 * store_api.php): webGui/include/local_prepend.php (the global
 * auto_prepend_file) already enforces CSRF on every plugin POST and
 * CONSUMES $_POST['csrf_token'] once it validates — a second check here
 * would always see an already-emptied field and reject every legitimate
 * request.
 */

declare(strict_types=1);

require_once __DIR__ . '/multinet.php';
require_once __DIR__ . '/docker.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function multinet_respond(array $body): void
{
    echo json_encode($body);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    multinet_respond(['ok' => false, 'error' => 'unraid-multinet: POST required']);
}

$action = $_POST['action'] ?? '';

/** Reserved names that can never be an additional-network target or be deleted. */
function multinet_is_protected_network(string $name): bool
{
    if (in_array($name, multinet_reserved_networks(), true)) {
        return true;
    }
    return (bool) preg_match('/^br\d/', $name);
}

/**
 * Read one template and compute its full multinet summary: primary
 * network/ip/mac (from the template, native dockerMan fields), the
 * parsed desired additional-network rows, which path is in effect, and
 * live state from `docker inspect` (only meaningful if the container is
 * actually running right now).
 */
function multinet_container_summary(string $templatePath, array $state): ?array
{
    $xml = @simplexml_load_file($templatePath);
    if ($xml === false) {
        return null;
    }
    $name = (string) $xml->Name;
    $primaryRaw = (string) $xml->Network;
    $primary = explode(':', $primaryRaw)[0]; // "container:foo" -> "container" for path selection, keep full for display
    $myIP = (string) $xml->MyIP;
    $myMAC = (string) $xml->MyMAC;
    $extraParams = multinet_xml_decode((string) $xml->ExtraParams);
    $postArgs = multinet_xml_decode((string) $xml->PostArgs);

    $expected = multinet_state_get($state, $name);
    $path = multinet_choose_path($primaryRaw);

    if ($path === 'extra') {
        $parsed = multinet_parse_extra($extraParams, $primary, $expected);
    } else {
        $parsed = multinet_parse_post($postArgs, $name, $expected);
    }

    $driver = $path === 'extra' ? multinet_docker_network_driver($primary) : null;
    $macSupported = $driver === 'bridge';

    $running = multinet_docker_container_running($name);
    $live = $running ? multinet_docker_container_networks($name) : [];

    return [
        'name' => $name,
        'repository' => (string) $xml->Repository,
        'primary' => $primaryRaw,
        'primary_ip' => $myIP,
        'primary_mac' => $myMAC,
        'primary_mac_supported' => $macSupported,
        'path' => $path,
        'rows' => $parsed['rows'],
        'manually_managed' => $parsed['manually_managed'],
        'running' => $running,
        'live_networks' => $live,
        'template_path' => $templatePath,
    ];
}

switch ($action) {
    case 'networks': {
        multinet_respond(['ok' => true, 'networks' => multinet_docker_networks()]);
    }

    case 'network_create': {
        $name = trim((string) ($_POST['name'] ?? ''));
        $driver = trim((string) ($_POST['driver'] ?? 'bridge'));
        $subnet = trim((string) ($_POST['subnet'] ?? '')) ?: null;
        $gateway = trim((string) ($_POST['gateway'] ?? '')) ?: null;
        $ipRange = trim((string) ($_POST['ip_range'] ?? '')) ?: null;
        $internal = ($_POST['internal'] ?? '') === '1';
        $parent = trim((string) ($_POST['parent'] ?? '')) ?: null;
        if ($name === '' || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/', $name)) {
            multinet_respond(['ok' => false, 'error' => 'invalid network name']);
        }
        if (multinet_is_protected_network($name)) {
            multinet_respond(['ok' => false, 'error' => 'that name is reserved']);
        }
        $res = multinet_docker_network_create($name, $driver, $subnet, $gateway, $ipRange, $internal, $parent);
        multinet_respond(['ok' => $res['ok'], 'error' => $res['ok'] ? null : trim($res['err'] ?: $res['out'])]);
    }

    case 'network_delete': {
        $name = trim((string) ($_POST['name'] ?? ''));
        if (multinet_is_protected_network($name)) {
            multinet_respond(['ok' => false, 'error' => 'refusing to delete a reserved network']);
        }
        $info = multinet_docker_network_inspect($name);
        if ($info && !empty($info['containers'])) {
            multinet_respond(['ok' => false, 'error' => 'refusing to delete: containers still attached']);
        }
        $res = multinet_docker_network_delete($name);
        multinet_respond(['ok' => $res['ok'], 'error' => $res['ok'] ? null : trim($res['err'] ?: $res['out'])]);
    }

    case 'containers': {
        $state = multinet_state_load();
        $out = [];
        foreach (multinet_list_templates() as $path) {
            $summary = multinet_container_summary($path, $state);
            if ($summary) {
                $out[] = $summary;
            }
        }
        multinet_respond(['ok' => true, 'containers' => $out]);
    }

    case 'get': {
        $name = trim((string) ($_POST['name'] ?? ''));
        $tpl = multinet_read_template($name);
        if (!$tpl) {
            multinet_respond(['ok' => false, 'error' => 'no template for that container']);
        }
        $state = multinet_state_load();
        $summary = multinet_container_summary($tpl['path'], $state);
        multinet_respond(['ok' => (bool) $summary, 'container' => $summary]);
    }

    case 'preview': {
        $primary = trim((string) ($_POST['primary'] ?? ''));
        $name = trim((string) ($_POST['name'] ?? ''));
        $mac = trim((string) ($_POST['mac'] ?? '')) ?: null;
        $rows = json_decode((string) ($_POST['rows'] ?? '[]'), true) ?: [];
        $path = multinet_choose_path($primary);
        if ($path === 'extra') {
            $driver = multinet_docker_network_driver($primary);
            $run = multinet_build_network_run($primary, $rows, $mac, $driver === 'bridge');
            multinet_respond(['ok' => true, 'path' => 'extra', 'fragment' => $run]);
        } else {
            $chain = multinet_build_connect_chain($name, $rows);
            multinet_respond(['ok' => true, 'path' => 'post', 'fragment' => $chain === '' ? '' : '&& ' . $chain]);
        }
    }

    case 'save': {
        $name = trim((string) ($_POST['name'] ?? ''));
        $rows = json_decode((string) ($_POST['rows'] ?? '[]'), true) ?: [];
        $tpl = multinet_read_template($name);
        if (!$tpl) {
            multinet_respond(['ok' => false, 'error' => 'no template for that container']);
        }
        $xml = $tpl['xml'];
        $primaryRaw = (string) $xml->Network;
        $primary = explode(':', $primaryRaw)[0];
        $myMAC = (string) $xml->MyMAC;
        $extraParams = multinet_xml_decode((string) $xml->ExtraParams);
        $postArgs = multinet_xml_decode((string) $xml->PostArgs);

        $state = multinet_state_load();
        $expected = multinet_state_get($state, $name);
        $path = multinet_choose_path($primaryRaw);

        foreach ($rows as $row) {
            if (empty($row['network']) || multinet_is_protected_network($row['network']) || $row['network'] === $primary) {
                multinet_respond(['ok' => false, 'error' => 'invalid additional network: ' . ($row['network'] ?? '')]);
            }
        }

        if ($path === 'extra') {
            $parsed = multinet_parse_extra($extraParams, $primary, $expected);
            if ($parsed['manually_managed']) {
                multinet_respond(['ok' => false, 'error' => 'manually managed: ExtraParams contains a --network block this plugin did not write. Refusing to rewrite it.', 'manually_managed' => true]);
            }
            $driver = multinet_docker_network_driver($primary);
            $run = multinet_build_network_run($primary, $rows, $myMAC ?: null, $driver === 'bridge');
            $newExtraParams = multinet_serialize_extra($parsed['remaining'], $run);
            $ok = multinet_write_template_field($tpl['path'], 'ExtraParams', $newExtraParams);
        } else {
            $parsed = multinet_parse_post($postArgs, $name, $expected);
            if ($parsed['manually_managed']) {
                multinet_respond(['ok' => false, 'error' => 'manually managed: PostArgs contains a docker network connect chain this plugin did not write. Refusing to rewrite it.', 'manually_managed' => true]);
            }
            $chain = multinet_build_connect_chain($name, $rows);
            $newPostArgs = multinet_serialize_post($parsed['remaining'], $chain);
            $ok = multinet_write_template_field($tpl['path'], 'PostArgs', $newPostArgs);
        }

        if (!$ok) {
            multinet_respond(['ok' => false, 'error' => 'failed to write template']);
        }

        $state = multinet_state_set($state, $name, $primaryRaw, $path, $rows);
        multinet_state_save($state);

        multinet_respond(['ok' => true, 'path' => $path]);
    }

    case 'apply': {
        // Reconcile LIVE docker network membership to match the template's
        // desired rows, without recreating the container — connect/disconnect
        // only. This is the automated replacement for the user's previous
        // manual `docker network connect` step; it does not touch the
        // container's primary network or restart it.
        $name = trim((string) ($_POST['name'] ?? ''));
        $tpl = multinet_read_template($name);
        if (!$tpl) {
            multinet_respond(['ok' => false, 'error' => 'no template for that container']);
        }
        if (!multinet_docker_container_running($name)) {
            multinet_respond(['ok' => false, 'error' => 'container is not running']);
        }
        $state = multinet_state_load();
        $summary = multinet_container_summary($tpl['path'], $state);
        $desired = [];
        foreach ($summary['rows'] as $row) {
            $desired[$row['network']] = $row;
        }
        $live = $summary['live_networks'];
        $primary = explode(':', $summary['primary'])[0];

        $actions = [];
        // Disconnect anything live that isn't primary and isn't desired.
        foreach ($live as $net => $info) {
            if ($net === $primary) {
                continue;
            }
            if (!isset($desired[$net])) {
                $res = multinet_docker_network_disconnect($net, $name);
                $actions[] = ['op' => 'disconnect', 'network' => $net, 'ok' => $res['ok'], 'error' => $res['ok'] ? null : trim($res['err'])];
            }
        }
        // Connect/reconnect anything desired that's missing or has drifted.
        foreach ($desired as $net => $row) {
            $current = $live[$net] ?? null;
            $needsReconnect = $current !== null && !empty($row['ip']) && $current['ip'] !== $row['ip'];
            if ($current === null || $needsReconnect) {
                if ($needsReconnect) {
                    $d = multinet_docker_network_disconnect($net, $name);
                    $actions[] = ['op' => 'disconnect', 'network' => $net, 'ok' => $d['ok'], 'error' => $d['ok'] ? null : trim($d['err'])];
                }
                $res = multinet_docker_network_connect($net, $name, $row['ip'] ?: null, $row['alias'] ?: null);
                $actions[] = ['op' => 'connect', 'network' => $net, 'ok' => $res['ok'], 'error' => $res['ok'] ? null : trim($res['err'])];
            }
        }

        $ok = true;
        foreach ($actions as $a) {
            if (!$a['ok']) {
                $ok = false;
            }
        }
        multinet_respond(['ok' => $ok, 'actions' => $actions]);
    }

    default:
        multinet_respond(['ok' => false, 'error' => 'unknown action']);
}
