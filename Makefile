# browser-agent top-level Makefile
# 详细说明见 scripts/ 各脚本和 docs/architecture.md

SHELL := /bin/bash
UPSTREAM_DIR ?= upstream
BUILD_DIR ?= build

.PHONY: help bootstrap patch build package package-deb package-windows clean reset

help:
	@echo "browser-agent build targets:"
	@echo "  make bootstrap   - 拉取上游 mozilla-firefox/firefox 源码"
	@echo "  make patch       - 应用 patches/ 下所有补丁"
	@echo "  make build       - 编译"
	@echo "  make package     - 使用 mach 打包当前平台产物"
	@echo "  make package-deb - 在 Ubuntu/Debian 打包 Linux 应用安装包"
	@echo "  make package-windows - 在 Linux 交叉编译 Windows x64 安装包与便携包"
	@echo "  make clean       - 清理构建产物"
	@echo "  make reset       - 还原 upstream/ 到干净状态（撤销所有补丁）"

bootstrap:
	./scripts/bootstrap.sh

patch:
	./scripts/apply-patches.sh

build:
	./scripts/build.sh

package:
	./scripts/package.sh

package-deb: package
	python3 scripts/package-linux-deb.py $(if $(LINUX_PACKAGE),"$(LINUX_PACKAGE)",dist/firefox-*.linux-*.tar.xz)

package-windows:
	bash scripts/build-windows-x64.sh

clean:
	rm -rf $(BUILD_DIR) $(UPSTREAM_DIR)/obj-*

reset:
	cd $(UPSTREAM_DIR) && git reset --hard && git clean -fdx
