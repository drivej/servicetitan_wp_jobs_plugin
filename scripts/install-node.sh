#!/usr/bin/env bash
set -euo pipefail

# Exact, checksum-verified runtime; Nixpacks' major-only selector is not sufficient.
node_release=24.22.1
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) node_platform=linux-x64; node_checksum=eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c ;;
  Linux-aarch64|Linux-arm64) node_platform=linux-arm64; node_checksum=33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3 ;;
  Darwin-arm64) node_platform=darwin-arm64; node_checksum=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7 ;;
  Darwin-x86_64) node_platform=darwin-x64; node_checksum=d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035 ;;
  *) echo 'Unsupported Node.js runtime platform.' >&2; exit 1 ;;
esac
node_destination="$PWD/.node-runtime"
if [[ -x "$node_destination/bin/node" ]] && [[ "$("$node_destination/bin/node" --version)" == "v$node_release" ]]; then
  echo "Node.js $node_release is installed."
  exit 0
fi
node_staging=$(mktemp -d)
trap 'rm -rf "$node_staging"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --max-time 180 \
  "https://nodejs.org/dist/v$node_release/node-v$node_release-$node_platform.tar.gz" -o "$node_staging/node.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  node_actual=$(sha256sum "$node_staging/node.tar.gz" | cut -d ' ' -f 1)
else
  node_actual=$(shasum -a 256 "$node_staging/node.tar.gz" | cut -d ' ' -f 1)
fi
[[ "$node_actual" == "$node_checksum" ]] || { echo 'Node.js checksum verification failed.' >&2; exit 1; }
mkdir "$node_staging/runtime"
tar -xzf "$node_staging/node.tar.gz" -C "$node_staging/runtime" --strip-components=1
[[ "$("$node_staging/runtime/bin/node" --version)" == "v$node_release" ]]
mkdir -p "$node_destination"
cp -R "$node_staging/runtime/." "$node_destination/"
echo "Installed Node.js $("$node_destination/bin/node" --version)."
