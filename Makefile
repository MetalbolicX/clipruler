GO ?= go
DIST ?= dist

.PHONY: beacon-test build test vet fmt fmt-fix clean

# Phase 1 diagnostic binary. Joins 224.0.0.251:42731 and prints every
# peer sighting; run on two machines to verify LAN discovery before the
# full migration work begins.
beacon-test:
	@mkdir -p $(DIST)
	$(GO) build -trimpath -o $(DIST)/beacon-test ./go/cmd/beacon-test

build: beacon-test

test:
	$(GO) test -short ./...

vet:
	$(GO) vet ./...

fmt:
	@gofmt -l go/

fmt-fix:
	@gofmt -w go/

clean:
	rm -rf $(DIST)
