package main

import (
	"encoding/binary"
	"errors"
	"math"
)

// BIFF is Visual Pinball's record format: [int32 length][4-char tag][payload],
// where length counts the tag plus the payload. A few tags break the rule:
// CODE (script) is followed by its own int32 length, and JPEG opens a nested
// record list that ends with its own ENDB.

var errBiffTruncated = errors.New("truncated BIFF record")

type biffReader struct {
	b   []byte
	pos int
}

// next returns the next record's tag and payload. For CODE the payload is
// the script; for JPEG it is empty and the caller continues reading the
// nested records with the same reader.
func (r *biffReader) next() (string, []byte, error) {
	if r.pos+8 > len(r.b) {
		return "", nil, errBiffTruncated
	}
	n := int(int32(binary.LittleEndian.Uint32(r.b[r.pos:])))
	tag := string(r.b[r.pos+4 : r.pos+8])
	switch tag {
	case "CODE":
		if r.pos+12 > len(r.b) {
			return "", nil, errBiffTruncated
		}
		cl := int(int32(binary.LittleEndian.Uint32(r.b[r.pos+8:])))
		start := r.pos + 12
		if cl < 0 || start+cl > len(r.b) {
			return "", nil, errBiffTruncated
		}
		r.pos = start + cl
		return tag, r.b[start : start+cl], nil
	case "JPEG":
		r.pos += 8
		return tag, nil, nil
	}
	if n < 4 || r.pos+4+n > len(r.b) {
		return "", nil, errBiffTruncated
	}
	data := r.b[r.pos+8 : r.pos+4+n]
	r.pos += 4 + n
	return tag, data, nil
}

func biffInt(d []byte) int {
	if len(d) < 4 {
		return 0
	}
	return int(int32(binary.LittleEndian.Uint32(d)))
}

func biffFloat(d []byte) float32 {
	if len(d) < 4 {
		return 0
	}
	return math.Float32frombits(binary.LittleEndian.Uint32(d))
}

// biffString decodes a length-prefixed 8-bit string.
func biffString(d []byte) string {
	if len(d) < 4 {
		return ""
	}
	n := biffInt(d)
	if n < 0 || 4+n > len(d) {
		n = len(d) - 4
	}
	return latin1(d[4 : 4+n])
}

func latin1(b []byte) string {
	r := make([]rune, 0, len(b))
	for _, c := range b {
		if c == 0 {
			break
		}
		r = append(r, rune(c))
	}
	return string(r)
}

// lenString reads an int32-prefixed byte string at pos (used by the sound
// streams, which are not BIFF).
func lenString(b []byte, pos int) (string, int, error) {
	if pos+4 > len(b) {
		return "", pos, errBiffTruncated
	}
	n := int(int32(binary.LittleEndian.Uint32(b[pos:])))
	if n < 0 || pos+4+n > len(b) {
		return "", pos, errBiffTruncated
	}
	return latin1(b[pos+4 : pos+4+n]), pos + 4 + n, nil
}
