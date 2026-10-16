#!/usr/bin/env bash
# Builds dist/gnome-shell-extension-auto-shutdown_<version>_all.deb
# (and a GNOME extension zip) from src/. Needs: dpkg-deb, glib-compile-schemas, python3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src"
BUILD="$ROOT/build"
DIST="$ROOT/dist"
PACKAGE="gnome-shell-extension-auto-shutdown"
MAINTAINER="${DEB_MAINTAINER:-Towhidul I Chowdhury <itowhid06@gmail.com>}"

json_field() {
    python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$SRC/metadata.json" "$1"
}

UUID="$(json_field uuid)"
VERSION="$(json_field version-name)"
EXTENSION_FILES=(metadata.json extension.js prefs.js dialog.js logind.js util.js stylesheet.css icons schemas)

echo "==> Staging $UUID $VERSION"
rm -rf "$BUILD"
mkdir -p "$BUILD/extension" "$DIST"
for f in "${EXTENSION_FILES[@]}"; do
    cp -r "$SRC/$f" "$BUILD/extension/"
done
glib-compile-schemas --strict "$BUILD/extension/schemas"

echo "==> Building extension zip"
python3 -I - "$BUILD/extension" "$DIST/$UUID.shell-extension.zip" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(src):
        for name in sorted(files):
            path = os.path.join(base, name)
            z.write(path, os.path.relpath(path, src))
PY

echo "==> Building Debian package"
PKGROOT="$BUILD/deb"
EXTDIR="$PKGROOT/usr/share/gnome-shell/extensions/$UUID"
DOCDIR="$PKGROOT/usr/share/doc/$PACKAGE"
mkdir -p "$EXTDIR" "$DOCDIR" "$PKGROOT/DEBIAN"
cp -r "$BUILD/extension/." "$EXTDIR/"

sed "s|@MAINTAINER@|$MAINTAINER|g" "$ROOT/packaging/debian/copyright" > "$DOCDIR/copyright"
gzip -9n -c "$ROOT/packaging/debian/changelog" > "$DOCDIR/changelog.gz"
cp "$ROOT/README.md" "$DOCDIR/README.md"

find "$PKGROOT" -type d -exec chmod 0755 {} +
find "$PKGROOT/usr" -type f -exec chmod 0644 {} +

INSTALLED_SIZE="$(du -sk --apparent-size "$PKGROOT/usr" | cut -f1)"
sed -e "s|@PACKAGE@|$PACKAGE|" \
    -e "s|@VERSION@|$VERSION|" \
    -e "s|@MAINTAINER@|$MAINTAINER|" \
    -e "s|@INSTALLED_SIZE@|$INSTALLED_SIZE|" \
    "$ROOT/packaging/debian/control.in" > "$PKGROOT/DEBIAN/control"
install -m 0755 "$ROOT/packaging/debian/postinst" "$PKGROOT/DEBIAN/postinst"

(cd "$PKGROOT" && find usr -type f -print0 | sort -z | xargs -0 md5sum) > "$PKGROOT/DEBIAN/md5sums"
chmod 0644 "$PKGROOT/DEBIAN/control" "$PKGROOT/DEBIAN/md5sums"

DEB="$DIST/${PACKAGE}_${VERSION}_all.deb"
dpkg-deb --root-owner-group -Zxz --build "$PKGROOT" "$DEB" >/dev/null

echo "==> Done"
echo "    $DEB"
echo "    $DIST/$UUID.shell-extension.zip"
