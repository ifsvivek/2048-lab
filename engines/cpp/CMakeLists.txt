cmake_minimum_required(VERSION 3.20)
project(g2048 VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()
# -O2 (not CMake's default -O3) for Release.
set(CMAKE_CXX_FLAGS_RELEASE "-O2 -DNDEBUG")

add_executable(g2048
  src/json.cpp
  src/engine.cpp
  src/ai.cpp
  src/bench.cpp
  src/validate.cpp
  src/main.cpp)

target_include_directories(g2048 PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
# -ffp-contract=off: never fuse the chance-node `sum + 0.9 * v` into an FMA, so
# search values stay bit-identical to the TypeScript reference.
target_compile_options(g2048 PRIVATE -Wall -Wextra -ffp-contract=off)

set_target_properties(g2048 PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/bin)
