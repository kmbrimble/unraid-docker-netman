<?php
// Fails (exit 1) if docker.netman.plg would not install: it must parse as XML with its
// DOCTYPE entities expanded, and version, pluginURL and md5 must be present and non-empty.
// Run by ci.yml, release.yml and scripts/build-plugin.sh. 0.3.6 shipped a .plg with a raw
// <Name> in CHANGES that Unraid could not parse ("XML file doesn't exist or xml parse error").
$file = $argv[1] ?? __DIR__ . '/../docker.netman.plg';
libxml_use_internal_errors(true);
$dom = new DOMDocument();
if (!$dom->loadXML((string) @file_get_contents($file), LIBXML_NOENT | LIBXML_NONET)) {
    foreach (libxml_get_errors() as $e) {
        fwrite(STDERR, sprintf("%s:%d: %s\n", basename($file), $e->line, trim($e->message)));
    }
    fwrite(STDERR, "check-plg: .plg does not parse\n");
    exit(1);
}
$root = $dom->documentElement;
$bad = [];
if ($root->nodeName !== 'PLUGIN') {
    $bad[] = 'root element is not PLUGIN';
}
foreach (['version', 'pluginURL'] as $attr) {
    if (trim($root->getAttribute($attr)) === '') {
        $bad[] = "PLUGIN $attr is missing or empty";
    }
}
$md5 = preg_match('/<!ENTITY\s+md5\s+"([^"]*)"/', (string) file_get_contents($file), $m) ? trim($m[1]) : null;
if ($md5 === null || !preg_match('/^[0-9a-f]{32}$/', $md5)) {
    $bad[] = 'md5 entity is missing or not a 32-hex checksum';
}
if ($bad) {
    fwrite(STDERR, "check-plg: " . implode("\ncheck-plg: ", $bad) . "\n");
    exit(1);
}
echo "check-plg: ok (version " . $root->getAttribute('version') . ")\n";
