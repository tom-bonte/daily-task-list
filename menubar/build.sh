#!/bin/bash
# Builds the menu bar app into ~/Applications/Habits Rabbits Menu.app
set -e
here="$(cd "$(dirname "$0")" && pwd)"
app="$HOME/Applications/Habits Rabbits Menu.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -O -o "$app/Contents/MacOS/HabitsRabbitsMenu" "$here/main.swift"
cp "$here/Info.plist" "$app/Contents/Info.plist"
cp "$here/Resources/"menubar*.png "$app/Contents/Resources/"
# A stable signing identity keeps the Accessibility permission across rebuilds;
# ad-hoc signatures change every time and macOS then treats it as a new app.
identity="Habits Rabbits Dev"
if security find-certificate -c "$identity" >/dev/null 2>&1; then
  codesign --force --sign "$identity" "$app"
else
  codesign --force --sign - "$app"
fi
echo "built: $app"
