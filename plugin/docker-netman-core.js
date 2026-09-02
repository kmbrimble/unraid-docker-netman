/**
 * Pure parse/serialize functions shared between the browser injector
 * (DockerNetManInject.page, DockerNetMan.page) and node tests
 * (tests/js.test.js). Mirrors plugin/include/netman.php's logic exactly —
 * this is the JS side of the same design, used client-side for live
 * preview only; the server (include/netman.php) is the actual source of
 * truth on save.
 *
 * UMD wrapper: `window.dockerNetman` in a browser, `module.exports` in node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.dockerNetman = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function tokenize(s) {
    var tokens = [];
    var i = 0;
    var len = s.length;
    while (i < len) {
      while (i < len && /\s/.test(s[i])) i++;
      if (i >= len) break;
      var tok = '';
      while (i < len && !/\s/.test(s[i])) {
        var c = s[i];
        if (c === '"' || c === "'") {
          var q = c;
          i++;
          while (i < len && s[i] !== q) {
            tok += s[i];
            i++;
          }
          i++;
        } else {
          tok += c;
          i++;
        }
      }
      tokens.push(tok);
    }
    return tokens;
  }

  function isNetworkFlag(tok) {
    return tok === '--network' || tok === '--net';
  }

  function parseAdvancedValue(value) {
    var out = {};
    value.split(',').forEach(function (kv) {
      var idx = kv.indexOf('=');
      if (idx === -1) {
        if (!out.network) out.network = kv;
        return;
      }
      var k = kv.slice(0, idx), v = kv.slice(idx + 1);
      if (k === 'name') out.network = v;
      else if (k === 'ip') out.ip = v;
      else if (k === 'alias') out.alias = v;
      else if (k === 'mac-address') out.mac = v;
    });
    return out;
  }

  function rowDefaults(row) {
    return {
      network: row.network || '',
      ip: row.ip || null,
      alias: row.alias || null,
      mac: row.mac || null,
    };
  }

  function rowsEqual(a, b) {
    // expected (b) is null/undefined when the caller has no state.json to compare
    // against (e.g. the browser injector, which never has state.json client-side) —
    // "unknown" must not be treated as a mismatch, or every container looks
    // manually-managed the moment expected isn't available. See CLAUDE.md.
    if (b == null) return true;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      var ra = rowDefaults(a[i]), rb = rowDefaults(b[i]);
      if (ra.network !== rb.network || ra.ip !== rb.ip || ra.alias !== rb.alias || ra.mac !== rb.mac) return false;
    }
    return true;
  }

  function shellQuoteIfNeeded(tok) {
    if (tok === '' || /[\s"']/.test(tok)) {
      return "'" + tok.replace(/'/g, "'\\''") + "'";
    }
    return tok;
  }

  function choosePath(primary) {
    if (primary === 'bridge' || primary === 'host' || primary === 'none' || primary.indexOf('container:') === 0) {
      return 'post';
    }
    return 'extra';
  }

  function parseExtra(extraParams, primary, expected) {
    var tokens = tokenize(extraParams);
    var n = tokens.length;
    var startIdx = null, primaryMac = null;
    for (var i = 0; i < n - 1; i++) {
      if (!isNetworkFlag(tokens[i])) continue;
      var val = tokens[i + 1];
      if (val === primary) { startIdx = i; break; }
      var parsed = parseAdvancedValue(val);
      if (parsed.network === primary) { startIdx = i; primaryMac = parsed.mac || null; break; }
    }
    if (startIdx === null) {
      return { remaining: extraParams, primary_mac: null, rows: [], found: false, manually_managed: false };
    }
    var rows = [];
    var j = startIdx + 2;
    while (j < n - 1 && isNetworkFlag(tokens[j])) {
      var p = parseAdvancedValue(tokens[j + 1]);
      if (!p.network) break;
      rows.push(rowDefaults(p));
      j += 2;
    }
    var endIdx = j;
    var remainingTokens = tokens.slice(0, startIdx).concat(tokens.slice(endIdx));
    var remaining = remainingTokens.map(shellQuoteIfNeeded).join(' ');
    var manuallyManaged = !rowsEqual(rows, expected);
    return { remaining: remaining, primary_mac: primaryMac, rows: rows, found: true, manually_managed: manuallyManaged };
  }

  function buildNetworkRun(primary, rows, primaryMac, primarySupportsMac) {
    var parts = [];
    if (primaryMac && primarySupportsMac) {
      parts.push('--network name=' + primary + ',mac-address=' + primaryMac);
    } else {
      parts.push('--network ' + primary);
    }
    rows.forEach(function (row) {
      row = rowDefaults(row);
      var kv = ['name=' + row.network];
      if (row.ip) kv.push('ip=' + row.ip);
      if (row.alias) kv.push('alias=' + row.alias);
      if (row.mac) kv.push('mac-address=' + row.mac);
      parts.push('--network ' + kv.join(','));
    });
    return parts.join(' ');
  }

  function serializeExtra(remaining, networkRun) {
    remaining = (remaining || '').trim();
    return remaining === '' ? networkRun : remaining + ' ' + networkRun;
  }

  function parsePost(postArgs, containerName, expected) {
    var tokens = tokenize(postArgs);
    var n = tokens.length;
    var chainStart = null;
    for (var i = 0; i < n; i++) {
      if (tokens[i] === 'docker' && tokens[i + 1] === 'network' && tokens[i + 2] === 'connect') {
        chainStart = i;
        if (i > 0 && ['&&', ';', '|'].indexOf(tokens[i - 1]) !== -1) chainStart = i - 1;
        break;
      }
    }
    if (chainStart === null) {
      return { remaining: postArgs, primary_mac: null, rows: [], found: false, manually_managed: false };
    }
    var rows = [];
    var j = chainStart, chainEnd = chainStart;
    outer:
    while (j < n) {
      if (['&&', ';', '|'].indexOf(tokens[j]) !== -1) j++;
      if (tokens[j] !== 'docker' || tokens[j + 1] !== 'network' || tokens[j + 2] !== 'connect') break;
      var k = j + 3, ip = null, alias = null;
      while (tokens[k] !== undefined && tokens[k].indexOf('--') === 0) {
        if (tokens[k] === '--ip') { ip = tokens[k + 1] || null; k += 2; }
        else if (tokens[k] === '--alias') { alias = tokens[k + 1] || null; k += 2; }
        else break outer;
      }
      var net = tokens[k] !== undefined ? tokens[k] : null;
      var ctn = tokens[k + 1] !== undefined ? tokens[k + 1] : null;
      if (net === null || ctn !== containerName) break;
      rows.push(rowDefaults({ network: net, ip: ip, alias: alias }));
      chainEnd = k + 2;
      j = chainEnd;
    }
    if (rows.length === 0) {
      return { remaining: postArgs, primary_mac: null, rows: [], found: false, manually_managed: false };
    }
    var remainingTokens = tokens.slice(0, chainStart).concat(tokens.slice(chainEnd));
    var remaining = remainingTokens.map(shellQuoteIfNeeded).join(' ');
    var manuallyManaged = !rowsEqual(rows, expected);
    return { remaining: remaining, primary_mac: null, rows: rows, found: true, manually_managed: manuallyManaged };
  }

  function buildConnectChain(containerName, rows) {
    return rows.map(function (row) {
      row = rowDefaults(row);
      var cmd = ['docker', 'network', 'connect'];
      if (row.ip) { cmd.push('--ip'); cmd.push(row.ip); }
      if (row.alias) { cmd.push('--alias'); cmd.push(row.alias); }
      cmd.push(row.network);
      cmd.push(containerName);
      return cmd.join(' ');
    }).join(' && ');
  }

  function serializePost(remaining, chain) {
    remaining = (remaining || '').replace(/\s+$/, '');
    if (chain === '') return remaining;
    return remaining === '' ? '&& ' + chain : remaining + ' && ' + chain;
  }

  return {
    tokenize: tokenize,
    choosePath: choosePath,
    parseExtra: parseExtra,
    buildNetworkRun: buildNetworkRun,
    serializeExtra: serializeExtra,
    parsePost: parsePost,
    buildConnectChain: buildConnectChain,
    serializePost: serializePost,
    rowsEqual: rowsEqual,
    rowDefaults: rowDefaults,
  };
});
