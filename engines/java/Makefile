# Java port of the canonical 2048 engine. JDK standard library only; no Maven/Gradle.
#   make          compile (javac --release 21) and build bin/g2048.jar + bin/g2048 launcher
#   make validate run every fixture check
#   make clean

JAVAC   ?= javac
JAR     ?= jar
RELEASE ?= 21

SRC     := $(shell find src/main/java -name '*.java')
CLASSES := build/classes
STAMP   := build/.compiled

.PHONY: all clean validate

all: bin/g2048.jar bin/g2048

$(STAMP): $(SRC)
	@rm -rf $(CLASSES)
	@mkdir -p $(CLASSES)
	$(JAVAC) --release $(RELEASE) -encoding UTF-8 -Xlint:all,-serial -d $(CLASSES) $(SRC)
	@touch $@

bin/g2048.jar: $(STAMP)
	@mkdir -p bin
	$(JAR) --create --file $@ --main-class dev.g2048.cli.Main -C $(CLASSES) .

bin/g2048: scripts/g2048
	@mkdir -p bin
	cp scripts/g2048 $@
	chmod +x $@

validate: all
	./bin/g2048 validate

clean:
	rm -rf build bin
