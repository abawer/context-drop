#!/usr/bin/env bash
# pack.sh - Create Chrome Web Store submission zip for Context Drop extension
# Packages only production files: manifest.json, icons/, src/
# Excludes: node_modules/, tests/, test-results/, package*.json, babel.config.json, jest.config.js, playwright.config.js, README.md, privacy-policy.md, .config/*, .git/*

set -euo pipefail

# Sanitize project name for ZIP filename
PROJECT_NAME="ai-context-drop"
ZIP_PROJECT_NAME=$(echo "${PROJECT_NAME}" | sed 's/ /-/g')

# Extract version from manifest.json
VERSION=$(grep '"version"' manifest.json | awk -F'"' '{print $4}')

ZIP_NAME="${ZIP_PROJECT_NAME}-${VERSION}.zip"

echo "Creating package: $ZIP_NAME"

# Create temporary packaging directory
TEMP_DIR=$(mktemp -d)
echo "Packaging to: $TEMP_DIR"

# Copy manifest.json to temp directory
cp manifest.json "$TEMP_DIR/"

# Copy icons/ directory to temp directory
cp -r icons "$TEMP_DIR/"

# Copy src/ directory to temp directory (full directory covering all imports)
cp -r src "$TEMP_DIR/"

# Create zip containing only the packaged files
zip -r "$ZIP_NAME" manifest.json icons/ src/

# Clean up temp directory
rm -rf "$TEMP_DIR"

echo "Done! Created: $ZIP_NAME"
echo ""
echo "Contents:"
unzip -l "$ZIP_NAME"