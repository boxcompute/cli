package main

import (
	"encoding/json"
	"net"
	"testing"
)

func freePort(t *testing.T) uint16 {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return uint16(listener.Addr().(*net.TCPAddr).Port)
}

func TestBindMappingsUsesLoopbackAndRejectsDuplicates(t *testing.T) {
	first, second := freePort(t), freePort(t)
	listeners, err := bindMappings([]serviceMapping{{Local: first, Remote: 3_000}, {Local: second, Remote: 8_080}})
	if err != nil {
		t.Fatal(err)
	}
	for _, listener := range listeners {
		if listener.Addr().(*net.TCPAddr).IP.String() != "127.0.0.1" {
			t.Fatalf("listener escaped loopback: %s", listener.Addr())
		}
		_ = listener.Close()
	}
	if duplicate, err := bindMappings([]serviceMapping{{Local: first, Remote: 3_000}, {Local: second, Remote: 3_000}}); err == nil {
		for _, listener := range duplicate {
			_ = listener.Close()
		}
		t.Fatal("duplicate remote port was accepted")
	}
}

func TestStrictJSONRejectsUnknownFields(t *testing.T) {
	var value struct {
		Mappings []serviceMapping `json:"mappings"`
	}
	if strictJSON([]byte(`{"mappings":[{"local":3000,"remote":3000}],"host":"0.0.0.0"}`), &value) == nil {
		t.Fatal("unknown field was accepted")
	}
	raw, _ := json.Marshal(struct {
		Mappings []serviceMapping `json:"mappings"`
	}{[]serviceMapping{{Local: 3_000, Remote: 3_000}}})
	if strictJSON(raw, &value) != nil {
		t.Fatal("valid mapping was rejected")
	}
}
