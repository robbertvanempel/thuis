#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/Thuis.app/Contents/{MacOS,Resources} build/Thuis.iconset
for arch in arm64 x86_64; do
  xcrun swiftc -swift-version 5 -O -target "${arch}-apple-macos13.0" Thuis.swift -o "build/Thuis-${arch}" -framework AppKit -framework WebKit
done
lipo -create build/Thuis-arm64 build/Thuis-x86_64 -output build/Thuis.app/Contents/MacOS/Thuis
xcrun swift Icon.swift build/Thuis.iconset
iconutil -c icns build/Thuis.iconset -o build/Thuis.app/Contents/Resources/Thuis.icns
cat > build/Thuis.app/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.thuis.desktop</string>
<key>CFBundleName</key><string>Thuis</string>
<key>CFBundleDisplayName</key><string>Thuis</string>
<key>CFBundleExecutable</key><string>Thuis</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>Thuis</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
codesign --force --sign - build/Thuis.app
printf 'Built: %s/build/Thuis.app\n' "$PWD"

ditto -c -k --sequesterRsrc --keepParent build/Thuis.app build/Thuis-macOS.zip
