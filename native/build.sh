#!/bin/sh
# Builds the universal macOS capture helper into native/meeting-tap, which release builds embed in
# main.js. The committed binary is built and attested by the "Helper" workflow; rebuild it locally
# only when working on native/macos/main.swift.
# With VAULT=/path/to/vault, also copies it into that vault's plugin folder.
set -e
cd "$(dirname "$0")"
mkdir -p build
for arch in arm64 x86_64; do
	swiftc -O -target "$arch-apple-macos14.4" macos/main.swift -o "build/meeting-tap-$arch" \
		-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker macos/Info.plist
done
lipo -create build/meeting-tap-arm64 build/meeting-tap-x86_64 -output meeting-tap
codesign --force --sign - --identifier io.github.azilone.muesli.tap meeting-tap
ls -lh meeting-tap
if [ -n "$VAULT" ]; then
	dest="$VAULT/.obsidian/plugins/muesli"
	mkdir -p "$dest"
	cp meeting-tap "$dest/meeting-tap"
	echo "Copied to $dest"
fi
