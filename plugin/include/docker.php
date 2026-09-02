<?php
/**
 * unraid-multinet — thin docker CLI wrappers. Every user-controlled value
 * goes through escapeshellarg(); nothing here is ever built by string
 * concatenation of unescaped input.
 */

function multinet_run(string $cmd): array
{
    $descriptors = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $proc = proc_open($cmd, $descriptors, $pipes);
    if (!is_resource($proc)) {
        return ['ok' => false, 'out' => '', 'err' => 'failed to start process', 'code' => -1];
    }
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($proc);
    return ['ok' => $code === 0, 'out' => $out, 'err' => $err, 'code' => $code];
}

function multinet_docker_networks(): array
{
    $res = multinet_run('docker network ls --format ' . escapeshellarg('{{.Name}}'));
    if (!$res['ok']) {
        return [];
    }
    $names = array_filter(array_map('trim', explode("\n", $res['out'])));
    $out = [];
    foreach ($names as $name) {
        $info = multinet_docker_network_inspect($name);
        if ($info) {
            $out[] = $info;
        }
    }
    return $out;
}

function multinet_docker_network_inspect(string $name): ?array
{
    $res = multinet_run('docker network inspect ' . escapeshellarg($name) . ' --format ' . escapeshellarg('{{json .}}'));
    if (!$res['ok']) {
        return null;
    }
    $data = json_decode(trim($res['out']), true);
    if (!is_array($data)) {
        return null;
    }
    $subnets = [];
    foreach ($data['IPAM']['Config'] ?? [] as $cfg) {
        $subnets[] = [
            'subnet' => $cfg['Subnet'] ?? null,
            'gateway' => $cfg['Gateway'] ?? null,
            'ip_range' => $cfg['IPRange'] ?? null,
        ];
    }
    $containers = [];
    foreach ($data['Containers'] ?? [] as $ctn) {
        $containers[] = [
            'name' => $ctn['Name'] ?? '',
            'ip' => isset($ctn['IPv4Address']) ? explode('/', $ctn['IPv4Address'])[0] : null,
            'mac' => $ctn['MacAddress'] ?? null,
        ];
    }
    return [
        'name' => $data['Name'] ?? $name,
        'driver' => $data['Driver'] ?? '',
        'internal' => (bool) ($data['Internal'] ?? false),
        'subnets' => $subnets,
        'containers' => $containers,
    ];
}

function multinet_docker_network_create(string $name, string $driver, ?string $subnet, ?string $gateway, ?string $ipRange, bool $internal, ?string $parent = null): array
{
    $cmd = 'docker network create --driver ' . escapeshellarg($driver);
    if ($subnet) {
        $cmd .= ' --subnet ' . escapeshellarg($subnet);
    }
    if ($gateway) {
        $cmd .= ' --gateway ' . escapeshellarg($gateway);
    }
    if ($ipRange) {
        $cmd .= ' --ip-range ' . escapeshellarg($ipRange);
    }
    if ($internal) {
        $cmd .= ' --internal';
    }
    if ($parent) {
        $cmd .= ' -o parent=' . escapeshellarg($parent);
    }
    $cmd .= ' -- ' . escapeshellarg($name);
    return multinet_run($cmd);
}

function multinet_docker_network_delete(string $name): array
{
    return multinet_run('docker network rm -- ' . escapeshellarg($name));
}

function multinet_docker_network_connect(string $network, string $container, ?string $ip, ?string $alias): array
{
    $cmd = 'docker network connect';
    if ($ip) {
        $cmd .= ' --ip ' . escapeshellarg($ip);
    }
    if ($alias) {
        $cmd .= ' --alias ' . escapeshellarg($alias);
    }
    $cmd .= ' -- ' . escapeshellarg($network) . ' ' . escapeshellarg($container);
    return multinet_run($cmd);
}

function multinet_docker_network_disconnect(string $network, string $container): array
{
    return multinet_run('docker network disconnect -- ' . escapeshellarg($network) . ' ' . escapeshellarg($container));
}

/** Live network membership for a running container: name -> ['ip'=>,'mac'=>]. Empty array if not running. */
function multinet_docker_container_networks(string $container): array
{
    $res = multinet_run('docker inspect ' . escapeshellarg($container) . ' --format ' . escapeshellarg('{{json .NetworkSettings.Networks}}'));
    if (!$res['ok']) {
        return [];
    }
    $data = json_decode(trim($res['out']), true);
    if (!is_array($data)) {
        return [];
    }
    $out = [];
    foreach ($data as $net => $info) {
        $out[$net] = ['ip' => $info['IPAddress'] ?? null, 'mac' => $info['MacAddress'] ?? null];
    }
    return $out;
}

function multinet_docker_container_running(string $container): bool
{
    $res = multinet_run('docker inspect ' . escapeshellarg($container) . ' --format ' . escapeshellarg('{{.State.Running}}'));
    return $res['ok'] && trim($res['out']) === 'true';
}

/** Driver of a network, or null if it doesn't exist. Used to gate MAC support (ipvlan rejects it — see CLAUDE.md). */
function multinet_docker_network_driver(string $name): ?string
{
    $res = multinet_run('docker network inspect ' . escapeshellarg($name) . ' --format ' . escapeshellarg('{{.Driver}}'));
    return $res['ok'] ? trim($res['out']) : null;
}
