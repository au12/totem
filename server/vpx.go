package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"unicode/utf16"
)

// packFormat changes whenever the pack layout or conversion changes, so old
// caches are rebuilt.
const packFormat = 3

// A pack is a .vpx table converted for the browser: the BIFF streams the
// engine parses, textures re-encoded and size-tiered for phones, the sounds
// as plain WAV files, and the backglass from the matching .directb2s.
type packManifest struct {
	Format    int               `json:"format"`
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	GameName  string            `json:"gameName"`
	Info      map[string]string `json:"info"`
	Streams   string            `json:"streams"`
	Textures  []*packTexture    `json:"textures"`
	Sounds    []*packSound      `json:"sounds"`
	Backglass *packBackglass    `json:"backglass,omitempty"`
	Bytes     map[string]int64  `json:"bytes"` // download size per quality tier
}

type packTexture struct {
	Name      string  `json:"name"`
	W         int     `json:"w"`
	H         int     `json:"h"`
	AlphaTest float32 `json:"alphaTest"`
	Alpha     bool    `json:"alpha"`
	HD        string  `json:"hd"`
	HDMask    string  `json:"hdMask,omitempty"`
	SD        string  `json:"sd"`
	SDMask    string  `json:"sdMask,omitempty"`
}

type packSound struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type packWriter struct {
	dir   string
	done  int
	mu    sync.Mutex
	files map[string]bool
	sizes map[string]int64 // tier -> bytes ("all" counts shared files)
}

// write stores data under prefix/<slug>.<hash>.<ext> and returns that path.
func (w *packWriter) write(prefix, slug, ext string, data []byte) (string, error) {
	sum := sha256.Sum256(data)
	name := fmt.Sprintf("%s/%s.%s.%s", prefix, slug, hex.EncodeToString(sum[:5]), ext)
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.files[name] {
		return name, nil
	}
	full := filepath.Join(w.dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(full, data, 0o644); err != nil {
		return "", err
	}
	w.files[name] = true
	return name, nil
}

func (w *packWriter) count(tier string, n int) {
	w.mu.Lock()
	w.sizes[tier] += int64(n)
	w.mu.Unlock()
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	s = strings.Trim(slugRe.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if len(s) > 40 {
		s = s[:40]
	}
	if s == "" {
		s = "x"
	}
	return s
}

var gameNameRe = regexp.MustCompile(`(?i)cGameName\s*=\s*"([^"]+)"`)

// buildPack converts one table into dir. It writes everything to a temporary
// sibling directory first and renames it into place, so an interrupted
// conversion never leaves a half pack behind.
func buildPack(vpxPath, b2sPath, dir, id string, progress func(float64)) (*packManifest, error) {
	if progress == nil {
		progress = func(float64) {}
	}
	raw, err := os.ReadFile(vpxPath)
	if err != nil {
		return nil, err
	}
	cf, err := openCompoundFile(raw)
	if err != nil {
		return nil, err
	}
	tmp := dir + ".tmp"
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return nil, err
	}
	w := &packWriter{dir: tmp, files: map[string]bool{}, sizes: map[string]int64{}}
	m := &packManifest{Format: packFormat, ID: id, Info: map[string]string{}, Bytes: map[string]int64{}}

	for _, k := range cf.Children("TableInfo") {
		if b, err := cf.Stream("TableInfo/" + k); err == nil {
			m.Info[k] = utf16le(b)
		}
	}
	m.Name = m.Info["TableName"]
	if m.Name == "" {
		m.Name = strings.TrimSuffix(filepath.Base(vpxPath), filepath.Ext(vpxPath))
	}

	gameData, err := cf.Stream("GameStg/GameData")
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	var script []byte
	r := &biffReader{b: gameData}
	for {
		tag, data, err := r.next()
		if err != nil {
			return nil, fmt.Errorf("GameData: %w", err)
		}
		if tag == "ENDB" {
			break
		}
		switch tag {
		case "SEDT", "SSND", "SIMG", "SCOL":
			counts[tag] = biffInt(data)
		case "CODE":
			script = data
		}
	}
	if mm := gameNameRe.FindSubmatch(script); mm != nil {
		m.GameName = strings.ToLower(string(mm[1]))
	}

	// Engine streams: GameData, the items and the collections.
	var bundle bytes.Buffer
	addStream := func(name string, data []byte) {
		var hdr [6]byte
		binary.LittleEndian.PutUint16(hdr[:2], uint16(len(name)))
		bundle.Write(hdr[:2])
		bundle.WriteString(name)
		binary.LittleEndian.PutUint32(hdr[2:], uint32(len(data)))
		bundle.Write(hdr[2:])
		bundle.Write(data)
	}
	addStream("GameData", gameData)
	for i := 0; i < counts["SEDT"]; i++ {
		s, err := cf.Stream(fmt.Sprintf("GameStg/GameItem%d", i))
		if err != nil {
			return nil, err
		}
		addStream(fmt.Sprintf("GameItem%d", i), s)
	}
	for i := 0; i < counts["SCOL"]; i++ {
		s, err := cf.Stream(fmt.Sprintf("GameStg/Collection%d", i))
		if err != nil {
			return nil, err
		}
		addStream(fmt.Sprintf("Collection%d", i), s)
	}
	if m.Streams, err = w.write("data", "streams", "bin", bundle.Bytes()); err != nil {
		return nil, err
	}
	w.count("all", bundle.Len())
	if err := writeGzip(filepath.Join(tmp, filepath.FromSlash(m.Streams)), bundle.Bytes()); err != nil {
		return nil, err
	}
	progress(0.1)

	// Textures, converted in parallel.
	m.Textures = make([]*packTexture, counts["SIMG"])
	errs := make([]error, counts["SIMG"])
	sem := make(chan struct{}, max(1, min(4, runtime.NumCPU())))
	var wg sync.WaitGroup
	for i := 0; i < counts["SIMG"]; i++ {
		s, err := cf.Stream(fmt.Sprintf("GameStg/Image%d", i))
		if err != nil {
			return nil, err
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, s []byte) {
			defer func() { <-sem; wg.Done() }()
			m.Textures[i], errs[i] = convertTexture(w, s)
			w.mu.Lock()
			w.done++
			done := w.done
			w.mu.Unlock()
			progress(0.1 + 0.7*float64(done)/float64(max(1, len(m.Textures))))
		}(i, s)
	}
	wg.Wait()
	kept := m.Textures[:0]
	for i, t := range m.Textures {
		if errs[i] != nil {
			log.Printf("  texture %d skipped: %v", i, errs[i])
			continue
		}
		kept = append(kept, t)
	}
	m.Textures = kept

	for i := 0; i < counts["SSND"]; i++ {
		s, err := cf.Stream(fmt.Sprintf("GameStg/Sound%d", i))
		if err != nil {
			return nil, err
		}
		snd, err := convertSound(w, s)
		if err != nil {
			log.Printf("  sound %d skipped: %v", i, err)
			continue
		}
		m.Sounds = append(m.Sounds, snd)
	}

	progress(0.85)
	if b2sPath != "" {
		bg, err := convertBackglass(w, b2sPath)
		if err != nil {
			log.Printf("  backglass %s skipped: %v", filepath.Base(b2sPath), err)
		} else {
			m.Backglass = bg
		}
	}

	m.Bytes["hd"] = w.sizes["all"] + w.sizes["hd"]
	m.Bytes["sd"] = w.sizes["all"] + w.sizes["sd"]
	mj, err := json.MarshalIndent(m, "", " ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(tmp, "manifest.json"), mj, 0o644); err != nil {
		return nil, err
	}
	if err := writeGzip(filepath.Join(tmp, "manifest.json"), mj); err != nil {
		return nil, err
	}
	progress(1)
	_ = os.RemoveAll(dir)
	if err := os.Rename(tmp, dir); err != nil {
		return nil, err
	}
	return m, nil
}

// writeGzip stores a .gz twin of a compressible file for the server to hand out.
func writeGzip(path string, data []byte) error {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if _, err := zw.Write(data); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if buf.Len() > len(data)*9/10 {
		return nil
	}
	return os.WriteFile(path+".gz", buf.Bytes(), 0o644)
}

func utf16le(b []byte) string {
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		c := binary.LittleEndian.Uint16(b[i:])
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return string(utf16.Decode(u))
}

const (
	hdMaxSide = 4096
	sdMaxSide = 2048
	// Textures smaller than this keep their alpha in a single PNG; bigger
	// ones ship as JPEG colour plus a grey PNG mask, which is far smaller.
	splitAlphaPixels = 512 * 512
)

func convertTexture(w *packWriter, s []byte) (*packTexture, error) {
	t := &packTexture{AlphaTest: 1}
	var payload []byte
	isBits := false
	r := &biffReader{b: s}
	nested := false
	for {
		tag, data, err := r.next()
		if err != nil {
			return nil, err
		}
		if nested {
			switch tag {
			case "DATA":
				payload = data
			case "ENDB":
				nested = false
			}
			continue
		}
		switch tag {
		case "NAME":
			t.Name = biffString(data)
		case "WDTH":
			t.W = biffInt(data)
		case "HGHT":
			t.H = biffInt(data)
		case "ALTV":
			t.AlphaTest = biffFloat(data)
		case "JPEG":
			nested = true
		case "BITS":
			isBits = true
		}
		if tag == "ENDB" || isBits {
			break
		}
	}
	if isBits {
		return nil, fmt.Errorf("%s: raw (BITS) images are not supported", t.Name)
	}
	if payload == nil {
		return nil, fmt.Errorf("%s: no image data", t.Name)
	}
	img, err := decodeImage(payload)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", t.Name, err)
	}
	t.W, t.H = img.Rect.Dx(), img.Rect.Dy()
	t.Alpha = hasAlpha(img)
	if t.Alpha {
		img = bleedColor(img)
	}
	slug := slugify(t.Name)
	hd := fitWithin(img, hdMaxSide)
	sd := fitWithin(hd, sdMaxSide)
	t.HD, t.HDMask, err = writeTier(w, "hd", "tex", slug, hd, t.Alpha)
	if err != nil {
		return nil, err
	}
	if sd == hd {
		t.SD, t.SDMask = t.HD, t.HDMask
		w.count("sd", int(w.size(t.HD)+w.size(t.HDMask)))
	} else if t.SD, t.SDMask, err = writeTier(w, "sd", "tex", slug+"-sd", sd, t.Alpha); err != nil {
		return nil, err
	}
	return t, nil
}

func (w *packWriter) size(name string) int64 {
	if name == "" {
		return 0
	}
	fi, err := os.Stat(filepath.Join(w.dir, filepath.FromSlash(name)))
	if err != nil {
		return 0
	}
	return fi.Size()
}

func writeTier(w *packWriter, tier, prefix, slug string, img *image.NRGBA, alpha bool) (string, string, error) {
	px := img.Rect.Dx() * img.Rect.Dy()
	if alpha && px <= splitAlphaPixels {
		b, err := encodePNG(img)
		if err != nil {
			return "", "", err
		}
		name, err := w.write(prefix, slug, "png", b)
		w.count(tier, len(b))
		return name, "", err
	}
	b, err := encodeJPEG(img, 88)
	if err != nil {
		return "", "", err
	}
	name, err := w.write(prefix, slug, "jpg", b)
	if err != nil {
		return "", "", err
	}
	w.count(tier, len(b))
	if !alpha {
		return name, "", nil
	}
	mb, err := encodePNG(alphaMask(img))
	if err != nil {
		return "", "", err
	}
	mask, err := w.write(prefix, slug+"-mask", "png", mb)
	w.count(tier, len(mb))
	return name, mask, err
}

// convertSound turns a VPX sound stream (name, path, internal name,
// WAVEFORMATEX, PCM data) into a standalone WAV file.
func convertSound(w *packWriter, s []byte) (*packSound, error) {
	name, pos, err := lenString(s, 0)
	if err != nil {
		return nil, err
	}
	path, pos, err := lenString(s, pos)
	if err != nil {
		return nil, err
	}
	if _, pos, err = lenString(s, pos); err != nil {
		return nil, err
	}
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".wav" && ext != "" {
		// Compressed sounds (ogg/mp3) are stored as the original file.
		if pos+4 > len(s) {
			return nil, errBiffTruncated
		}
		n := int(binary.LittleEndian.Uint32(s[pos:]))
		if pos+4+n > len(s) {
			return nil, errBiffTruncated
		}
		url, err := w.write("snd", slugify(name), strings.TrimPrefix(ext, "."), s[pos+4:pos+4+n])
		w.count("all", n)
		return &packSound{Name: name, URL: url}, err
	}
	if pos+18+4 > len(s) {
		return nil, errBiffTruncated
	}
	wfx := s[pos : pos+16] // PCMWAVEFORMAT; cbSize is not needed for PCM
	pos += 18
	n := int(binary.LittleEndian.Uint32(s[pos:]))
	pos += 4
	if n < 0 || pos+n > len(s) {
		return nil, errBiffTruncated
	}
	if binary.LittleEndian.Uint16(wfx) != 1 {
		return nil, errors.New(name + ": only PCM sounds are supported")
	}
	var wav bytes.Buffer
	wav.WriteString("RIFF")
	_ = binary.Write(&wav, binary.LittleEndian, uint32(4+8+16+8+n))
	wav.WriteString("WAVEfmt ")
	_ = binary.Write(&wav, binary.LittleEndian, uint32(16))
	wav.Write(wfx)
	wav.WriteString("data")
	_ = binary.Write(&wav, binary.LittleEndian, uint32(n))
	wav.Write(s[pos : pos+n])
	url, err := w.write("snd", "s", "wav", wav.Bytes()) // content-addressed: duplicates share a file
	if err != nil {
		return nil, err
	}
	w.mu.Lock()
	first := !w.files["counted:"+url]
	w.files["counted:"+url] = true
	w.mu.Unlock()
	if first {
		w.count("all", wav.Len())
	}
	return &packSound{Name: name, URL: url}, nil
}
