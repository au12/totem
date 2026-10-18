package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"strconv"
	"strings"
)

// decodeImage decodes the image formats found inside VPX tables and
// directb2s backglasses: PNG, JPEG and Radiance HDR (environment maps).
func decodeImage(data []byte) (*image.NRGBA, error) {
	if bytes.HasPrefix(data, []byte("#?")) {
		return decodeHDR(data)
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	return toNRGBA(img), nil
}

func toNRGBA(img image.Image) *image.NRGBA {
	if n, ok := img.(*image.NRGBA); ok && n.Rect.Min == (image.Point{}) {
		return n
	}
	b := img.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	switch src := img.(type) {
	case *image.RGBA:
		for y := 0; y < b.Dy(); y++ {
			for x := 0; x < b.Dx(); x++ {
				c := src.RGBAAt(b.Min.X+x, b.Min.Y+y)
				out.SetNRGBA(x, y, color.NRGBAModel.Convert(c).(color.NRGBA))
			}
		}
	default:
		for y := 0; y < b.Dy(); y++ {
			for x := 0; x < b.Dx(); x++ {
				out.Set(x, y, img.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	}
	return out
}

// alphaStats reports whether an image uses its alpha channel at all.
func hasAlpha(img *image.NRGBA) bool {
	p := img.Pix
	for i := 3; i < len(p); i += 4 {
		if p[i] != 255 {
			return true
		}
	}
	return false
}

// halve downsamples by two with alpha-weighted box filtering, so
// transparent pixels do not darken the edges of cut-out art.
func halve(src *image.NRGBA) *image.NRGBA {
	w, h := src.Rect.Dx(), src.Rect.Dy()
	nw, nh := (w+1)/2, (h+1)/2
	dst := image.NewNRGBA(image.Rect(0, 0, nw, nh))
	for y := 0; y < nh; y++ {
		for x := 0; x < nw; x++ {
			var r, g, b, a, n float64
			for dy := 0; dy < 2; dy++ {
				sy := 2*y + dy
				if sy >= h {
					sy = h - 1
				}
				for dx := 0; dx < 2; dx++ {
					sx := 2*x + dx
					if sx >= w {
						sx = w - 1
					}
					i := sy*src.Stride + sx*4
					pa := float64(src.Pix[i+3])
					r += float64(src.Pix[i]) * pa
					g += float64(src.Pix[i+1]) * pa
					b += float64(src.Pix[i+2]) * pa
					a += pa
					n++
				}
			}
			o := y*dst.Stride + x*4
			if a > 0 {
				dst.Pix[o] = uint8(r/a + 0.5)
				dst.Pix[o+1] = uint8(g/a + 0.5)
				dst.Pix[o+2] = uint8(b/a + 0.5)
			}
			dst.Pix[o+3] = uint8(a/n + 0.5)
		}
	}
	return dst
}

// fitWithin halves the image until its longest side is at most max.
func fitWithin(img *image.NRGBA, max int) *image.NRGBA {
	for img.Rect.Dx() > max || img.Rect.Dy() > max {
		img = halve(img)
	}
	return img
}

// bleedColor gives fully transparent pixels the colour of the nearest art
// (push-pull fill over an image pyramid, linear time), so texture filtering
// and JPEG blocks at the edge of cut-out art pick up the right colour
// instead of black fringes.
func bleedColor(img *image.NRGBA) *image.NRGBA {
	type level struct {
		w, h  int
		rgb   []float32
		known []bool
	}
	w, h := img.Rect.Dx(), img.Rect.Dy()
	l0 := level{w: w, h: h, rgb: make([]float32, w*h*3), known: make([]bool, w*h)}
	for i := 0; i < w*h; i++ {
		if img.Pix[i*4+3] > 0 {
			l0.known[i] = true
			l0.rgb[i*3] = float32(img.Pix[i*4])
			l0.rgb[i*3+1] = float32(img.Pix[i*4+1])
			l0.rgb[i*3+2] = float32(img.Pix[i*4+2])
		}
	}
	levels := []level{l0}
	for {
		p := levels[len(levels)-1]
		if p.w == 1 && p.h == 1 {
			break
		}
		nw, nh := (p.w+1)/2, (p.h+1)/2
		n := level{w: nw, h: nh, rgb: make([]float32, nw*nh*3), known: make([]bool, nw*nh)}
		for y := 0; y < nh; y++ {
			for x := 0; x < nw; x++ {
				var r, g, b float32
				c := 0
				for dy := 0; dy < 2; dy++ {
					sy := 2*y + dy
					if sy >= p.h {
						continue
					}
					for dx := 0; dx < 2; dx++ {
						sx := 2*x + dx
						if sx >= p.w || !p.known[sy*p.w+sx] {
							continue
						}
						i := (sy*p.w + sx) * 3
						r += p.rgb[i]
						g += p.rgb[i+1]
						b += p.rgb[i+2]
						c++
					}
				}
				if c > 0 {
					o := y*nw + x
					n.known[o] = true
					n.rgb[o*3], n.rgb[o*3+1], n.rgb[o*3+2] = r/float32(c), g/float32(c), b/float32(c)
				}
			}
		}
		levels = append(levels, n)
	}
	top := &levels[len(levels)-1]
	if !top.known[0] {
		top.known[0] = true
		top.rgb[0], top.rgb[1], top.rgb[2] = 128, 128, 128
	}
	for k := len(levels) - 2; k >= 0; k-- {
		l, up := &levels[k], &levels[k+1]
		for y := 0; y < l.h; y++ {
			for x := 0; x < l.w; x++ {
				i := y*l.w + x
				if l.known[i] {
					continue
				}
				j := (y/2)*up.w + x/2
				l.rgb[i*3], l.rgb[i*3+1], l.rgb[i*3+2] = up.rgb[j*3], up.rgb[j*3+1], up.rgb[j*3+2]
				l.known[i] = true
			}
		}
	}
	out := image.NewNRGBA(img.Rect)
	copy(out.Pix, img.Pix)
	for i := 0; i < w*h; i++ {
		if img.Pix[i*4+3] == 0 {
			out.Pix[i*4] = uint8(levels[0].rgb[i*3] + 0.5)
			out.Pix[i*4+1] = uint8(levels[0].rgb[i*3+1] + 0.5)
			out.Pix[i*4+2] = uint8(levels[0].rgb[i*3+2] + 0.5)
		}
	}
	return out
}

func encodeJPEG(img *image.NRGBA, quality int) ([]byte, error) {
	// Flatten to opaque RGB (alpha is shipped separately when needed).
	w, h := img.Rect.Dx(), img.Rect.Dy()
	rgb := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < w*h; i++ {
		rgb.Pix[i*4] = img.Pix[i*4]
		rgb.Pix[i*4+1] = img.Pix[i*4+1]
		rgb.Pix[i*4+2] = img.Pix[i*4+2]
		rgb.Pix[i*4+3] = 255
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, rgb, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func encodePNG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// alphaMask extracts the alpha channel as an 8-bit grey PNG image.
func alphaMask(img *image.NRGBA) *image.Gray {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	g := image.NewGray(image.Rect(0, 0, w, h))
	for i := 0; i < w*h; i++ {
		g.Pix[i] = img.Pix[i*4+3]
	}
	return g
}

// decodeHDR reads a Radiance RGBE image and tone-maps it to 8-bit sRGB.
// VPX uses these for the ball's environment reflection.
func decodeHDR(data []byte) (*image.NRGBA, error) {
	br := bufio.NewReader(bytes.NewReader(data))
	var w, h int
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return nil, errors.New("hdr: truncated header")
		}
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "-Y ") || strings.HasPrefix(line, "+Y ") {
			f := strings.Fields(line)
			if len(f) != 4 {
				return nil, errors.New("hdr: bad resolution line")
			}
			h, _ = strconv.Atoi(f[1])
			w, _ = strconv.Atoi(f[3])
			break
		}
	}
	if w <= 0 || h <= 0 || w > 16384 || h > 16384 {
		return nil, fmt.Errorf("hdr: bad size %dx%d", w, h)
	}
	rgbe := make([]byte, w*h*4)
	scan := make([]byte, w*4)
	for y := 0; y < h; y++ {
		var hdr [4]byte
		if _, err := ioReadFull(br, hdr[:]); err != nil {
			return nil, err
		}
		if w >= 8 && w < 32768 && hdr[0] == 2 && hdr[1] == 2 && int(hdr[2])<<8|int(hdr[3]) == w {
			for c := 0; c < 4; c++ {
				for x := 0; x < w; {
					n, err := br.ReadByte()
					if err != nil {
						return nil, err
					}
					if n > 128 {
						v, err := br.ReadByte()
						if err != nil {
							return nil, err
						}
						for k := 0; k < int(n)-128 && x < w; k++ {
							scan[x*4+c] = v
							x++
						}
					} else {
						for k := 0; k < int(n) && x < w; k++ {
							v, err := br.ReadByte()
							if err != nil {
								return nil, err
							}
							scan[x*4+c] = v
							x++
						}
					}
				}
			}
		} else {
			copy(scan, hdr[:])
			if _, err := ioReadFull(br, scan[4:]); err != nil {
				return nil, err
			}
		}
		copy(rgbe[y*w*4:], scan)
	}
	out := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < w*h; i++ {
		e := rgbe[i*4+3]
		var f float64
		if e != 0 {
			f = math.Ldexp(1, int(e)-136)
		}
		for c := 0; c < 3; c++ {
			v := float64(rgbe[i*4+c]) * f
			v = v / (1 + v) * 1.6 // gentle Reinhard keeps highlights
			if v > 1 {
				v = 1
			}
			out.Pix[i*4+c] = uint8(math.Pow(v, 1/2.2)*255 + 0.5)
		}
		out.Pix[i*4+3] = 255
	}
	return out, nil
}

func ioReadFull(br *bufio.Reader, b []byte) (int, error) {
	n := 0
	for n < len(b) {
		m, err := br.Read(b[n:])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}
