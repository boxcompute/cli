package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKeygenCreatesOneOwnerOnlyPrivateKey(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "node.json")
	var output bytes.Buffer
	if err := keygen(path, &output); err != nil {
		t.Fatal(err)
	}
	var public struct {
		ClientKey string `json:"client_key"`
	}
	if err := json.Unmarshal(output.Bytes(), &public); err != nil || !strings.HasPrefix(public.ClientKey, "nodekey:") {
		t.Fatalf("invalid public key output")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("private key mode = %o", info.Mode().Perm())
	}
	if err := keygen(path, &bytes.Buffer{}); err == nil {
		t.Fatal("keygen replaced an existing private key")
	}
}

func TestKeygenRejectsNonPrivateDirectory(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0755); err != nil {
		t.Fatal(err)
	}
	if err := keygen(filepath.Join(directory, "node.json"), &bytes.Buffer{}); err == nil {
		t.Fatal("keygen accepted a non-private directory")
	}
}
