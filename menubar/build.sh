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
codesign --force --sign - "$app"
echo "built: $app"
