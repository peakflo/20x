#!/bin/bash
set -e

pnpm version patch --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
git add package.json
git commit -m "release v$VERSION"
git tag "v$VERSION"
git push
git push --tags

echo "Released v$VERSION"
