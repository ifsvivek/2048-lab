# Lua port: nothing to compile. The default target checks that a Lua >= 5.4
# is available (via the launcher) and makes the launcher executable.
.PHONY: all check validate clean

all:
	@chmod +x bin/g2048
	@bin/g2048 --help >/dev/null

validate: all
	@bin/g2048 validate

clean:
	@true
