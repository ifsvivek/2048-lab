CC      ?= cc
# -ffp-contract=off: never fuse `sum + 0.9*v` into an FMA, so chance-node values
# are bit-identical to the TypeScript reference (spec/AI.md §3).
CFLAGS  ?= -O2
CFLAGS  += -std=c11 -Wall -Wextra -ffp-contract=off -D_POSIX_C_SOURCE=200809L -D_DEFAULT_SOURCE
LDLIBS  += -lm

SRC := $(wildcard src/*.c)
OBJ := $(patsubst src/%.c,obj/%.o,$(SRC))
BIN := bin/g2048

.PHONY: all clean validate

all: $(BIN)

$(BIN): $(OBJ) | bin
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(OBJ) $(LDLIBS)

obj/%.o: src/%.c $(wildcard src/*.h) | obj
	$(CC) $(CFLAGS) -c -o $@ $<

bin obj:
	mkdir -p $@

validate: $(BIN)
	./$(BIN) validate

clean:
	rm -rf bin obj
