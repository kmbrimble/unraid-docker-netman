#!/bin/bash
# Read-only verification for the terrible-butler live test (docs/SPEC.md C.3).
# Run over SSH on the host. Checks:
#   1. docker inspect shows BOTH bridge and proxynet=172.18.0.3
#   2. https://butler.kiztigs.com/ returns 200/302 (not 502)
#   3. NPM can reach terrible-butler over proxynet by name
# Never modifies anything.

set -uo pipefail

CT=terrible-butler
NET=proxynet
IP=172.18.0.3
NPM=Nginx-Proxy-Manager-Official

fail=0

echo "--- docker inspect: network membership ---"
NETWORKS=$(docker inspect "$CT" --format '{{json .NetworkSettings.Networks}}' 2>&1)
echo "$NETWORKS"
BRIDGE_IP=$(docker inspect "$CT" --format '{{with index .NetworkSettings.Networks "bridge"}}{{.IPAddress}}{{end}}' 2>/dev/null)
[ -n "$BRIDGE_IP" ] || { echo "FAIL: bridge not attached"; fail=1; }
NET_IP=$(docker inspect "$CT" --format "{{with index .NetworkSettings.Networks \"$NET\"}}{{.IPAddress}}{{end}}" 2>/dev/null)
[ "$NET_IP" = "$IP" ] || { echo "FAIL: $NET not attached at $IP (got '$NET_IP')"; fail=1; }

echo
echo "--- https://butler.kiztigs.com/ ---"
CODE=$(curl -sk -o /dev/null -w '%{http_code}' https://butler.kiztigs.com/)
echo "HTTP $CODE"
case "$CODE" in
  200|302) ;;
  *) echo "FAIL: expected 200/302, got $CODE"; fail=1 ;;
esac

echo
echo "--- NPM -> terrible-butler:2626 over $NET ---"
if docker exec "$NPM" curl -s -o /dev/null -w '%{http_code}' "http://$CT:2626/" 2>/tmp/npm-curl-err; then
  CODE2=$(docker exec "$NPM" curl -s -o /dev/null -w '%{http_code}' "http://$CT:2626/")
  echo "HTTP $CODE2 (from NPM)"
  [ "$CODE2" = "200" ] || [ "$CODE2" = "302" ] || { echo "FAIL: NPM cannot reach $CT by name"; fail=1; }
else
  echo "NPM curl exec failed:"; cat /tmp/npm-curl-err
  fail=1
fi

echo
if [ "$fail" = "0" ]; then
  echo "ALL CHECKS PASSED"
else
  echo "SOME CHECKS FAILED"
fi
exit "$fail"
