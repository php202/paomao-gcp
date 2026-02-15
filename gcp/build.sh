#!/bin/bash
# Run from gcp directory: ./build.sh
set -e
cd "$(dirname "$0")"
[ -f set-env.sh ] && source set-env.sh
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/gcp-scripts/pao-run:latest"
echo "Building and pushing $IMAGE"
gcloud builds submit --tag "$IMAGE"
