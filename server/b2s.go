package main

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"image"
	"image/draw"
	"io"
	"os"
	"strconv"
	"strings"
)

// The .directb2s file is the cabinet backglass: XML with base64 images. We
// keep the artwork, the score display positions, and the lamps (bulbs) so the
// browser can light them from the game state.

type packBackglass struct {
	W      int        `json:"w"`
	H      int        `json:"h"`
	Off    tierPair   `json:"off"`
	On     tierPair   `json:"on"`
	Scores []b2sScore `json:"scores"`
	Lamps  []b2sLamp  `json:"lamps"`
	Color  string     `json:"color,omitempty"`
}

type tierPair struct {
	HD string `json:"hd"`
	SD string `json:"sd"`
}

type b2sScore struct {
	ID     int    `json:"id"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
	W      int    `json:"w"`
	H      int    `json:"h"`
	Digits int    `json:"digits"`
	Lit    string `json:"lit,omitempty"`
}

type b2sLamp struct {
	ID       int      `json:"id"`
	Name     string   `json:"name,omitempty"`
	Text     string   `json:"text,omitempty"`
	RomID    int      `json:"romId"`
	RomType  int      `json:"romType"`
	Inverted bool     `json:"inverted"`
	X        int      `json:"x"`
	Y        int      `json:"y"`
	W        int      `json:"w"`
	H        int      `json:"h"`
	Image    tierPair `json:"image"`
}

type b2sBulb struct {
	attrs map[string]string
	img   *image.NRGBA
}

func b2sAttrs(se xml.StartElement) map[string]string {
	m := make(map[string]string, len(se.Attr))
	for _, a := range se.Attr {
		m[a.Name.Local] = a.Value
	}
	return m
}

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

func decodeB64Image(s string) (*image.NRGBA, error) {
	s = strings.NewReplacer("\r", "", "\n", "", " ", "").Replace(s)
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	return decodeImage(b)
}

// rgbHex turns B2S "r.g.b" colours into "#rrggbb".
func rgbHex(s string) string {
	p := strings.Split(s, ".")
	if len(p) != 3 {
		return ""
	}
	const hexd = "0123456789abcdef"
	out := []byte{'#'}
	for _, c := range p {
		v := atoi(c)
		if v < 0 || v > 255 {
			return ""
		}
		out = append(out, hexd[v>>4], hexd[v&15])
	}
	return string(out)
}

func convertBackglass(w *packWriter, path string) (*packBackglass, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	dec := xml.NewDecoder(f)
	dec.Strict = false
	var base *image.NRGBA
	var bulbs []*b2sBulb
	bg := &packBackglass{}
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		a := b2sAttrs(se)
		switch se.Name.Local {
		case "BackglassImage":
			if base, err = decodeB64Image(a["Value"]); err != nil {
				return nil, err
			}
		case "Score":
			if a["Parent"] != "" && a["Parent"] != "Backglass" {
				continue
			}
			bg.Scores = append(bg.Scores, b2sScore{
				ID: atoi(a["ID"]), X: atoi(a["LocX"]), Y: atoi(a["LocY"]), W: atoi(a["Width"]), H: atoi(a["Height"]),
				Digits: atoi(a["Digits"]), Lit: rgbHex(a["ReelLitColor"]),
			})
		case "Bulb":
			if a["Parent"] != "" && a["Parent"] != "Backglass" {
				continue
			}
			b := &b2sBulb{attrs: a}
			if a["Image"] != "" {
				if b.img, err = decodeB64Image(a["Image"]); err != nil {
					continue
				}
			}
			bulbs = append(bulbs, b)
		}
	}
	if base == nil {
		return nil, errors.New("no backglass image")
	}
	bg.W, bg.H = base.Rect.Dx(), base.Rect.Dy()

	off := image.NewNRGBA(base.Rect)
	draw.Draw(off, off.Rect, base, image.Point{}, draw.Src)
	var art []*b2sBulb
	for _, b := range bulbs {
		if b.img == nil {
			continue
		}
		a := b.attrs
		at := image.Rect(atoi(a["LocX"]), atoi(a["LocY"]), atoi(a["LocX"])+atoi(a["Width"]), atoi(a["LocY"])+atoi(a["Height"]))
		switch {
		case atoi(a["RomID"]) == 0 && a["InitialState"] == "1":
			// Always-lit illumination: bake it into both versions.
			draw.Draw(off, at, scaleTo(b.img, at.Dx(), at.Dy()), image.Point{}, draw.Over)
		case at.Dx() >= bg.W*9/10 && at.Dy() >= bg.H*9/10:
			// Full-size illumination layer: the "lights on" artwork.
			art = append(art, b)
		default:
			lamp := b2sLamp{
				ID: atoi(a["ID"]), Name: a["Name"], Text: strings.ReplaceAll(strings.ReplaceAll(a["Text"], "\r", ""), "\n", " "),
				RomID: atoi(a["RomID"]), RomType: atoi(a["RomIDType"]), Inverted: a["RomInverted"] == "1",
				X: at.Min.X, Y: at.Min.Y, W: at.Dx(), H: at.Dy(),
			}
			img := scaleTo(b.img, at.Dx(), at.Dy())
			for _, tier := range []struct {
				name string
				max  int
			}{{"hd", 1}, {"sd", 2}} {
				im := img
				if tier.max == 2 {
					im = halve(img)
				}
				data, err := encodePNG(im)
				if err != nil {
					return nil, err
				}
				url, err := w.write("b2s", "lamp-"+strconv.Itoa(lamp.ID), "png", data)
				if err != nil {
					return nil, err
				}
				w.count(tier.name, len(data))
				if tier.name == "hd" {
					lamp.Image.HD = url
				} else {
					lamp.Image.SD = url
				}
			}
			bg.Lamps = append(bg.Lamps, lamp)
		}
	}
	on := image.NewNRGBA(off.Rect)
	draw.Draw(on, on.Rect, off, image.Point{}, draw.Src)
	for _, b := range art {
		draw.Draw(on, on.Rect, scaleTo(b.img, bg.W, bg.H), image.Point{}, draw.Over)
	}
	for _, v := range []struct {
		img *image.NRGBA
		dst *tierPair
		key string
	}{{off, &bg.Off, "off"}, {on, &bg.On, "on"}} {
		hd := fitWithin(v.img, 2560)
		sd := fitWithin(hd, 1300)
		for _, t := range []struct {
			img  *image.NRGBA
			tier string
			out  *string
		}{{hd, "hd", &v.dst.HD}, {sd, "sd", &v.dst.SD}} {
			data, err := encodeJPEG(t.img, 86)
			if err != nil {
				return nil, err
			}
			if *t.out, err = w.write("b2s", "backglass-"+v.key+"-"+t.tier, "jpg", data); err != nil {
				return nil, err
			}
			w.count(t.tier, len(data))
		}
	}
	return bg, nil
}

// scaleTo returns img unchanged when it already has the size; B2S images are
// normally stored at their placed size. Otherwise it resamples (nearest).
func scaleTo(img *image.NRGBA, w, h int) *image.NRGBA {
	if w <= 0 || h <= 0 || (img.Rect.Dx() == w && img.Rect.Dy() == h) {
		return img
	}
	out := image.NewNRGBA(image.Rect(0, 0, w, h))
	sw, sh := img.Rect.Dx(), img.Rect.Dy()
	for y := 0; y < h; y++ {
		sy := y * sh / h
		for x := 0; x < w; x++ {
			sx := x * sw / w
			copy(out.Pix[y*out.Stride+x*4:y*out.Stride+x*4+4], img.Pix[sy*img.Stride+sx*4:])
		}
	}
	return out
}

var _ = bytes.MinRead
