package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"time"
)

// tables finds .vpx tables in the data folder and converts each one, once,
// into a browser pack under the state folder. Packs are keyed by the source
// files' names, sizes and dates, so replacing a file triggers a rebuild.
type tables struct {
	dataDir  string
	packDir  string
	mu       sync.Mutex
	entries  map[string]*tableEntry // by pack id
	scanned  time.Time
	building map[string]bool
	sem      chan struct{}
}

type tableEntry struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	GameName string  `json:"gameName"`
	Status   string  `json:"status"` // converting | ready | error
	Pack     string  `json:"pack,omitempty"`
	Error    string  `json:"error,omitempty"`
	Progress float64 `json:"progress"`
	File     string  `json:"file"`
	vpx, b2s string
}

const (
	maxScanDepth = 5
	maxScanFiles = 20000
	rescanEvery  = 15 * time.Second
)

func newTables(dataDir, stateDir string) *tables {
	packDir := filepath.Join(stateDir, "packs")
	if err := os.MkdirAll(packDir, 0o755); err != nil || !writable(packDir) {
		alt := filepath.Join(os.TempDir(), "totem-packs")
		log.Printf("warning: %s is not writable (%v); converted tables go to %s and are rebuilt after a restart", packDir, err, alt)
		packDir = alt
		_ = os.MkdirAll(packDir, 0o755)
	}
	return &tables{dataDir: dataDir, packDir: packDir, entries: map[string]*tableEntry{}, building: map[string]bool{}, sem: make(chan struct{}, 1)}
}

func writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}

type source struct {
	vpx, b2s string
	id       string
}

// scan walks the data folder for tables. Only *.vpx (and a matching
// *.directb2s) are ever read, so nothing else in the volume is exposed.
func (t *tables) scan() []source {
	var found []source
	files := 0
	_ = filepath.WalkDir(t.dataDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(t.dataDir, p)
		if d.IsDir() {
			if rel != "." && (strings.Count(rel, string(filepath.Separator)) >= maxScanDepth || strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		files++
		if files > maxScanFiles {
			return filepath.SkipAll
		}
		if strings.EqualFold(filepath.Ext(p), ".vpx") {
			found = append(found, source{vpx: p})
		}
		return nil
	})
	for i := range found {
		found[i].b2s = findBackglass(found[i].vpx)
		found[i].id = sourceID(found[i].vpx, found[i].b2s)
	}
	sort.Slice(found, func(i, j int) bool { return found[i].vpx < found[j].vpx })
	return found
}

// findBackglass prefers "<table>.directb2s" next to the table, else the only
// .directb2s in the same folder.
func findBackglass(vpx string) string {
	dir := filepath.Dir(vpx)
	base := strings.TrimSuffix(filepath.Base(vpx), filepath.Ext(vpx))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var any []string
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".directb2s") {
			continue
		}
		if strings.EqualFold(strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())), base) {
			return filepath.Join(dir, e.Name())
		}
		any = append(any, filepath.Join(dir, e.Name()))
	}
	if len(any) == 1 {
		return any[0]
	}
	return ""
}

func sourceID(vpx, b2s string) string {
	h := sha256.New()
	fmt.Fprintf(h, "format=%d\n", packFormat)
	for _, p := range []string{vpx, b2s} {
		if p == "" {
			continue
		}
		if fi, err := os.Stat(p); err == nil {
			fmt.Fprintf(h, "%s|%d|%d\n", filepath.Base(p), fi.Size(), fi.ModTime().UnixNano())
		}
	}
	return hex.EncodeToString(h.Sum(nil)[:6])
}

// refresh rescans when stale and starts conversions for new tables.
func (t *tables) refresh(force bool) {
	t.mu.Lock()
	if !force && time.Since(t.scanned) < rescanEvery {
		t.mu.Unlock()
		return
	}
	t.scanned = time.Now()
	t.mu.Unlock()

	sources := t.scan()
	t.mu.Lock()
	defer t.mu.Unlock()
	next := map[string]*tableEntry{}
	for _, s := range sources {
		e := t.entries[s.id]
		if e == nil {
			name := strings.TrimSuffix(filepath.Base(s.vpx), filepath.Ext(s.vpx))
			e = &tableEntry{ID: s.id, Name: name, File: filepath.Base(s.vpx), vpx: s.vpx, b2s: s.b2s, Status: "converting"}
			dir := filepath.Join(t.packDir, s.id)
			if m, err := readManifest(dir); err == nil {
				e.Status, e.Name, e.GameName, e.Pack, e.Progress = "ready", m.Name, m.GameName, "pack/"+s.id+"/", 1
			}
		}
		next[s.id] = e
		if e.Status == "converting" && !t.building[s.id] {
			t.building[s.id] = true
			go t.convert(e)
		}
	}
	t.entries = next
	go t.cleanup(next)
}

func (t *tables) convert(e *tableEntry) {
	t.sem <- struct{}{} // one conversion at a time keeps memory use modest
	defer func() { <-t.sem }()
	start := time.Now()
	log.Printf("converting %s (backglass: %s)", e.File, filepath.Base(e.b2s))
	dir := filepath.Join(t.packDir, e.ID)
	m, err := buildPack(e.vpx, e.b2s, dir, e.ID, func(p float64) {
		t.mu.Lock()
		e.Progress = p
		t.mu.Unlock()
	})
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.building, e.ID)
	if err != nil {
		e.Status, e.Error = "error", err.Error()
		log.Printf("could not convert %s: %v", e.File, err)
		return
	}
	e.Status, e.Name, e.GameName, e.Pack, e.Progress = "ready", m.Name, m.GameName, "pack/"+e.ID+"/", 1
	go debug.FreeOSMemory() // the conversion's image buffers are not needed any more
	log.Printf("converted %s in %s: %d textures, %d sounds, %.1f MB to download",
		e.File, time.Since(start).Round(time.Millisecond), len(m.Textures), len(m.Sounds), float64(m.Bytes["hd"])/1e6)
}

// cleanup removes packs of tables that are gone or have changed.
func (t *tables) cleanup(keep map[string]*tableEntry) {
	entries, err := os.ReadDir(t.packDir)
	if err != nil {
		return
	}
	for _, d := range entries {
		name := d.Name()
		id := strings.TrimSuffix(name, ".tmp")
		if _, ok := keep[id]; ok {
			continue
		}
		if strings.HasSuffix(name, ".tmp") {
			t.mu.Lock()
			busy := t.building[id]
			t.mu.Unlock()
			if busy {
				continue
			}
		}
		_ = os.RemoveAll(filepath.Join(t.packDir, name))
	}
}

func readManifest(dir string) (*packManifest, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, err
	}
	var m packManifest
	if err := jsonUnmarshal(raw, &m); err != nil {
		return nil, err
	}
	if m.Format != packFormat {
		return nil, fmt.Errorf("old pack format %d", m.Format)
	}
	return &m, nil
}

func (t *tables) list() []tableEntry {
	t.refresh(false)
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]tableEntry, 0, len(t.entries))
	for _, e := range t.entries {
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool {
		// Totem first, then by name.
		if (out[i].GameName == "totem") != (out[j].GameName == "totem") {
			return out[i].GameName == "totem"
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// ServeHTTP serves /pack/<id>/<file>. File names inside a pack carry their
// content hash, so they are cached forever; the manifest is revalidated.
func (t *tables) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	id, file, ok := strings.Cut(rest, "/")
	if !ok || file == "" || strings.Contains(file, "..") {
		http.NotFound(w, r)
		return
	}
	t.mu.Lock()
	e := t.entries[id]
	ready := e != nil && e.Status == "ready"
	t.mu.Unlock()
	if !ready {
		http.NotFound(w, r)
		return
	}
	full := filepath.Join(t.packDir, id, filepath.FromSlash(file))
	fi, err := os.Stat(full)
	if err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", typeFor(file))
	h.Add("Vary", "Accept-Encoding")
	if file == "manifest.json" {
		h.Set("Cache-Control", "no-cache")
	} else {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	serve := full
	if acceptsEncoding(r.Header.Get("Accept-Encoding"), "gzip") {
		if _, err := os.Stat(full + ".gz"); err == nil {
			serve = full + ".gz"
			h.Set("Content-Encoding", "gzip")
		}
	}
	f, err := os.Open(serve)
	if err != nil {
		http.Error(w, "unavailable", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	h.Set("ETag", `"`+id+"-"+path.Base(serve)+`"`)
	http.ServeContent(w, r, "", fi.ModTime(), f)
}
