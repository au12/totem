package main

// A small reader for Microsoft Compound File Binary documents (the "OLE"
// container format that .vpx tables are stored in). It loads the whole file
// into memory, which is fine for pinball tables (tens of megabytes), and
// exposes the storage tree as paths like "GameStg/GameItem12".

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf16"
)

var cfbSignature = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}

const (
	cfbEndOfChain = 0xFFFFFFFE
	cfbFreeSect   = 0xFFFFFFFF
	cfbNoStream   = 0xFFFFFFFF
	cfbMaxChain   = 1 << 22
)

type cfbEntry struct {
	name   string
	kind   byte // 1 storage, 2 stream, 5 root
	left   uint32
	right  uint32
	child  uint32
	start  uint32
	size   uint64
	parent string // path of the containing storage ("" for the root's children)
}

type compoundFile struct {
	data          []byte
	sectorSize    int
	miniSectSize  int
	miniCutoff    uint64
	fat           []uint32
	miniFat       []uint32
	entries       []cfbEntry
	miniStream    []byte
	streams       map[string]*cfbEntry // full path -> entry
	storageChilds map[string][]string  // storage path -> child names
}

func openCompoundFile(data []byte) (*compoundFile, error) {
	if len(data) < 512 || !bytes.Equal(data[:8], cfbSignature) {
		return nil, errors.New("not a compound document (bad signature)")
	}
	le := binary.LittleEndian
	cf := &compoundFile{data: data, streams: map[string]*cfbEntry{}, storageChilds: map[string][]string{}}
	sectorShift := le.Uint16(data[30:])
	miniShift := le.Uint16(data[32:])
	if sectorShift != 9 && sectorShift != 12 {
		return nil, fmt.Errorf("unsupported sector size 2^%d", sectorShift)
	}
	cf.sectorSize = 1 << sectorShift
	cf.miniSectSize = 1 << miniShift
	numFatSectors := le.Uint32(data[44:])
	firstDirSector := le.Uint32(data[48:])
	cf.miniCutoff = uint64(le.Uint32(data[56:]))
	firstMiniFat := le.Uint32(data[60:])
	numMiniFat := le.Uint32(data[64:])
	firstDifat := le.Uint32(data[68:])
	numDifat := le.Uint32(data[72:])

	// Collect FAT sector numbers from the header DIFAT and the DIFAT chain.
	var fatSectors []uint32
	for i := 0; i < 109; i++ {
		s := le.Uint32(data[76+4*i:])
		if s == cfbFreeSect || s == cfbEndOfChain {
			continue
		}
		fatSectors = append(fatSectors, s)
	}
	difat := firstDifat
	for i := uint32(0); i < numDifat && difat != cfbEndOfChain && difat != cfbFreeSect; i++ {
		sec, err := cf.sector(difat)
		if err != nil {
			return nil, err
		}
		n := cf.sectorSize/4 - 1
		for j := 0; j < n; j++ {
			s := le.Uint32(sec[4*j:])
			if s != cfbFreeSect && s != cfbEndOfChain {
				fatSectors = append(fatSectors, s)
			}
		}
		difat = le.Uint32(sec[4*n:])
	}
	if uint32(len(fatSectors)) < numFatSectors {
		return nil, errors.New("truncated FAT")
	}
	for _, s := range fatSectors {
		sec, err := cf.sector(s)
		if err != nil {
			return nil, err
		}
		for j := 0; j < cf.sectorSize; j += 4 {
			cf.fat = append(cf.fat, le.Uint32(sec[j:]))
		}
	}

	dir, err := cf.chain(firstDirSector, 0)
	if err != nil {
		return nil, fmt.Errorf("directory: %w", err)
	}
	for off := 0; off+128 <= len(dir); off += 128 {
		e := dir[off : off+128]
		nameLen := int(le.Uint16(e[64:]))
		if nameLen > 64 {
			nameLen = 64
		}
		u := make([]uint16, 0, 32)
		for i := 0; i+1 < nameLen; i += 2 {
			c := le.Uint16(e[i:])
			if c == 0 {
				break
			}
			u = append(u, c)
		}
		cf.entries = append(cf.entries, cfbEntry{
			name:  string(utf16.Decode(u)),
			kind:  e[66],
			left:  le.Uint32(e[68:]),
			right: le.Uint32(e[72:]),
			child: le.Uint32(e[76:]),
			start: le.Uint32(e[116:]),
			size:  le.Uint64(e[120:]) & 0xFFFFFFFF, // v3 files: high dword is undefined
		})
	}
	if len(cf.entries) == 0 || cf.entries[0].kind != 5 {
		return nil, errors.New("missing root entry")
	}
	if sectorShift == 12 {
		for i := range cf.entries {
			cf.entries[i].size = cf.entriesSizeV4(i, dir)
		}
	}

	if numMiniFat > 0 && firstMiniFat != cfbEndOfChain {
		mf, err := cf.chain(firstMiniFat, 0)
		if err != nil {
			return nil, fmt.Errorf("mini FAT: %w", err)
		}
		for j := 0; j+4 <= len(mf); j += 4 {
			cf.miniFat = append(cf.miniFat, le.Uint32(mf[j:]))
		}
	}
	root := cf.entries[0]
	if root.start != cfbEndOfChain && root.size > 0 {
		if cf.miniStream, err = cf.chain(root.start, root.size); err != nil {
			return nil, fmt.Errorf("mini stream: %w", err)
		}
	}

	visited := make([]bool, len(cf.entries))
	if err := cf.walk(root.child, "", visited); err != nil {
		return nil, err
	}
	return cf, nil
}

func (cf *compoundFile) entriesSizeV4(i int, dir []byte) uint64 {
	return binary.LittleEndian.Uint64(dir[i*128+120:])
}

func (cf *compoundFile) sector(n uint32) ([]byte, error) {
	off := (int(n) + 1) * cf.sectorSize
	if n >= cfbEndOfChain-1 || off+cf.sectorSize > len(cf.data) {
		if off < len(cf.data) {
			return cf.data[off:], nil // last sector may be short
		}
		return nil, fmt.Errorf("sector %d out of range", n)
	}
	return cf.data[off : off+cf.sectorSize], nil
}

// chain reads a regular sector chain; size 0 reads the whole chain.
func (cf *compoundFile) chain(start uint32, size uint64) ([]byte, error) {
	var out []byte
	if size > 0 {
		out = make([]byte, 0, size)
	}
	s := start
	for n := 0; s != cfbEndOfChain; n++ {
		if n > cfbMaxChain || int(s) >= len(cf.fat) {
			return nil, fmt.Errorf("broken sector chain at %d", s)
		}
		sec, err := cf.sector(s)
		if err != nil {
			return nil, err
		}
		out = append(out, sec...)
		if size > 0 && uint64(len(out)) >= size {
			return out[:size], nil
		}
		s = cf.fat[s]
	}
	if size > 0 && uint64(len(out)) < size {
		return nil, errors.New("stream shorter than its directory size")
	}
	return out, nil
}

func (cf *compoundFile) miniChain(start uint32, size uint64) ([]byte, error) {
	out := make([]byte, 0, size)
	s := start
	for n := 0; uint64(len(out)) < size; n++ {
		if s == cfbEndOfChain || n > cfbMaxChain || int(s) >= len(cf.miniFat) {
			return nil, errors.New("broken mini sector chain")
		}
		off := int(s) * cf.miniSectSize
		if off+cf.miniSectSize > len(cf.miniStream) {
			return nil, errors.New("mini sector out of range")
		}
		out = append(out, cf.miniStream[off:off+cf.miniSectSize]...)
		s = cf.miniFat[s]
	}
	return out[:size], nil
}

func (cf *compoundFile) walk(id uint32, parent string, visited []bool) error {
	if id == cfbNoStream {
		return nil
	}
	if int(id) >= len(cf.entries) || visited[id] {
		return errors.New("corrupt directory tree")
	}
	visited[id] = true
	e := &cf.entries[id]
	if err := cf.walk(e.left, parent, visited); err != nil {
		return err
	}
	full := e.name
	if parent != "" {
		full = parent + "/" + e.name
	}
	cf.storageChilds[parent] = append(cf.storageChilds[parent], e.name)
	switch e.kind {
	case 2:
		cf.streams[full] = e
	case 1:
		if err := cf.walk(e.child, full, visited); err != nil {
			return err
		}
	}
	return cf.walk(e.right, parent, visited)
}

// Stream returns the contents of the stream at path ("Storage/Stream").
func (cf *compoundFile) Stream(path string) ([]byte, error) {
	e := cf.streams[path]
	if e == nil {
		return nil, fmt.Errorf("no stream %q", path)
	}
	if e.size == 0 {
		return []byte{}, nil
	}
	if e.size < cf.miniCutoff {
		return cf.miniChain(e.start, e.size)
	}
	return cf.chain(e.start, e.size)
}

func (cf *compoundFile) Has(path string) bool { return cf.streams[path] != nil }

// Children lists the entry names directly inside a storage.
func (cf *compoundFile) Children(storage string) []string { return cf.storageChilds[storage] }
