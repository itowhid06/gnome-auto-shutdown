UUID := auto-shutdown@itowhid06.github.io
USER_EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all deb install-deb install-user uninstall-user test screenshots clean

all: deb

## Build dist/*.deb and the extension zip
deb:
	./scripts/build-deb.sh

## Install the built .deb system-wide (asks for sudo)
install-deb: deb
	sudo apt install ./dist/gnome-shell-extension-auto-shutdown_*_all.deb

## Install for the current user only, without a package
install-user: deb
	rm -rf "$(USER_EXT_DIR)"
	mkdir -p "$(USER_EXT_DIR)"
	cp -r build/extension/. "$(USER_EXT_DIR)/"
	@echo "Installed to $(USER_EXT_DIR). Log out and back in, then: gnome-extensions enable $(UUID)"

uninstall-user:
	rm -rf "$(USER_EXT_DIR)"

## Load the extension in a throwaway headless GNOME Shell (dry-run mode) and take screenshots
test: deb
	./scripts/test-headless.sh

## Same as test, and also refresh docs/screenshots/
screenshots: deb
	mkdir -p docs/screenshots
	AUTO_SHUTDOWN_DOCS_DIR="$(CURDIR)/docs/screenshots" ./scripts/test-headless.sh

clean:
	rm -rf build dist
