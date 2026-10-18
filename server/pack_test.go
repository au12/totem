package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBuildPack(t *testing.T) {
	vpx := os.Getenv("TOTEM_VPX")
	if vpx == "" {
		t.Skip("set TOTEM_VPX to a .vpx file")
	}
	out := filepath.Join(t.TempDir(), "pack")
	if d := os.Getenv("TOTEM_OUT"); d != "" {
		out = d
	}
	start := time.Now()
	m, err := buildPack(vpx, os.Getenv("TOTEM_B2S"), out, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("built %s (%s) in %s: %d textures, %d sounds, bytes %v", m.Name, m.GameName, time.Since(start), len(m.Textures), len(m.Sounds), m.Bytes)
}
