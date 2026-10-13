#!/bin/sh
# Builds the universal macOS capture helper into native/bin/meeting-tap.
# With VAULT=/path/to/vault, also copies it into that vault's plugin folder.
set -e
cd "$(dirname "$0")"
mkdir -p bin build
for arch in arm64 x86_64; do
	swiftc -O -target "$arch-apple-macos14.4" macos/main.swift -o "build/meeting-tap-$arch" \
		-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker macos/Info.plist
done
lipo -create build/meeting-tap-arm64 build/meeting-tap-x86_64 -output bin/meeting-tap
codesign --force --sign - --identifier io.github.azilone.meeting-notes.tap bin/meeting-tap
ls -lh bin/meeting-tap
if [ -n "$VAULT" ]; then
	dest="$VAULT/.obsidian/plugins/dictee"
	mkdir -p "$dest"
	cp bin/meeting-tap "$dest/meeting-tap"
	echo "Copied to $dest"
fi
