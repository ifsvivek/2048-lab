# Thin wrapper: `make` builds bin/g2048 via CMake (Release). Falls back to a
# direct compiler invocation when cmake is not installed.
# Other compiler: `CXX=clang++ make BUILD_DIR=build-clang`.
BUILD_DIR ?= build
CMAKE     := $(shell command -v cmake 2>/dev/null)
SOURCES   := $(wildcard src/*.cpp)
DIRECT_FLAGS = -std=c++20 -O2 -DNDEBUG -Wall -Wextra -ffp-contract=off -Iinclude

.PHONY: all build validate clean

all: build

ifneq ($(CMAKE),)
build: $(BUILD_DIR)/CMakeCache.txt
	@env -u MAKEFLAGS -u MFLAGS cmake --build $(BUILD_DIR) --parallel $(shell nproc 2>/dev/null || echo 4) $(if $(findstring s,$(firstword -$(MAKEFLAGS))),> /dev/null)

$(BUILD_DIR)/CMakeCache.txt: CMakeLists.txt
	@cmake -S . -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=Release > /dev/null
else
build:
	@mkdir -p bin
	$(CXX) $(DIRECT_FLAGS) $(SOURCES) -o bin/g2048
endif

validate: build
	./bin/g2048 validate

clean:
	rm -rf $(BUILD_DIR) bin
