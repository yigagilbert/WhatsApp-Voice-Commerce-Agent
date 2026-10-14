#!/usr/bin/env bash
# Build and push the Katale AI production images to Docker Hub.
#
#   KATALE_IMAGE_NAMESPACE=yigagilbert ./scripts/release-images.sh
#
# Tags (immutable + convenience):
#   <ns>/katale-{api,web,whatsapp}:v<version>-<UTC yyyymmddHHMM>   ← deploy this
#   <ns>/katale-{api,web,whatsapp}:<git-short-sha>                 (when the repo has commits)
#   <ns>/katale-{api,web,whatsapp}:latest                          (convenience only)
#
# Options (env): KATALE_TAG=<tag> to override, PLATFORMS=linux/amd64 to build one arch,
# SKIP_TESTS=1 to skip `pnpm verify`. Requires `docker login` (Docker Hub) beforehand.
set -euo pipefail
cd "$(dirname "$0")/.."

NS="${KATALE_IMAGE_NAMESPACE:?set KATALE_IMAGE_NAMESPACE (Docker Hub username)}"
VERSION="$(node -p "require('./package.json').version")"
TAG="${KATALE_TAG:-v${VERSION}-$(date -u +%Y%m%d%H%M)}"
SHA="$(git rev-parse --short HEAD 2>/dev/null || true)"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER=katale-builder

if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  pnpm verify
fi

docker buildx inspect "$BUILDER" >/dev/null 2>&1 ||
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null

for target in api web whatsapp; do
  repo="$NS/katale-$target"
  tags=(-t "$repo:$TAG" -t "$repo:latest")
  [[ -n "$SHA" ]] && tags+=(-t "$repo:$SHA")
  echo "==> $repo:$TAG ($PLATFORMS)"
  docker buildx build --builder "$BUILDER" --platform "$PLATFORMS" \
    -f docker/Dockerfile --target "$target" "${tags[@]}" \
    --label "org.opencontainers.image.version=$TAG" \
    --label "org.opencontainers.image.title=katale-$target" \
    --provenance=false --push .
done

echo
echo "Pushed tag: $TAG"
for target in api web whatsapp; do
  docker buildx imagetools inspect "$NS/katale-$target:$TAG" --format '{{json .Manifest}}' |
    node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d);console.log('$NS/katale-$target:$TAG', m.digest)})"
done
echo "Deploy on the VM: set KATALE_TAG=$TAG in /opt/apps/katale-ai/.env, then run deploy/vm-deploy.sh"
