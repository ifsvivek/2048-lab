# Build the C# port: `make` -> build/publish/G2048.dll (framework-dependent).
# dotnet is located like bin/g2048 does: $DOTNET_ROOT, ~/.dotnet, then PATH.

DOTNET ?= $(shell \
	if [ -n "$$DOTNET_ROOT" ] && [ -x "$$DOTNET_ROOT/dotnet" ]; then echo "$$DOTNET_ROOT/dotnet"; \
	elif [ -x "$$HOME/.dotnet/dotnet" ]; then echo "$$HOME/.dotnet/dotnet"; \
	else command -v dotnet; fi)
DOTNET_DIR := $(patsubst %/,%,$(dir $(DOTNET)))

export DOTNET_CLI_TELEMETRY_OPTOUT := 1
export DOTNET_NOLOGO := 1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE := 1
export DOTNET_ROOT ?= $(DOTNET_DIR)

SOURCES := $(shell find src -name '*.cs') G2048.csproj
OUT := build/publish/G2048.dll

.PHONY: all clean run-validate

all: $(OUT)

$(OUT): $(SOURCES)
	@test -n "$(DOTNET)" || { echo "dotnet SDK not found (set DOTNET_ROOT or install to ~/.dotnet)" >&2; exit 1; }
	@$(DOTNET) publish G2048.csproj -c Release -o build/publish --nologo -v quiet -clp:NoSummary -p:UseAppHost=false
	@touch $(OUT)

run-validate: all
	./bin/g2048 validate

clean:
	rm -rf build obj bin/Debug bin/Release
