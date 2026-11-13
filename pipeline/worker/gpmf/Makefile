# gpmf-parser v2.2.1 (github.com/gopro/gpmf-parser). Licenses are in third_party/gpmf-parser/.
CC ?= gcc
CFLAGS ?= -O2 -Wall -Wno-unused-function -D_FILE_OFFSET_BITS=64
CPPFLAGS += -Ithird_party/gpmf-parser -Ithird_party/gpmf-parser/demo
LDFLAGS += -lm

OBJS = gpmf2json.o third_party/gpmf-parser/GPMF_parser.o third_party/gpmf-parser/demo/GPMF_mp4reader.o

gpmf2json: $(OBJS)
	$(CC) $(CFLAGS) -o $@ $(OBJS) $(LDFLAGS)

%.o: %.c
	$(CC) $(CFLAGS) $(CPPFLAGS) -c -o $@ $<

clean:
	rm -f gpmf2json $(OBJS)

.PHONY: clean
