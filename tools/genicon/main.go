// Command genicon converts assets/icon_1024.png into assets/app.ico: a
// multi-size Windows icon (16/24/32/48/64/128/256 px, PNG-compressed
// entries). icon_1024.png is rasterised from icon.svg with Edge headless:
//   msedge --headless=new --default-background-color=00000000 --window-size=1024,1024 --screenshot=assets/icon_1024.png assets/_render.html
//
// Run from the repo root: go run ./tools/genicon
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image/png"
	"os"
	"path/filepath"

	"github.com/disintegration/imaging"
)

var sizes = []int{16, 24, 32, 48, 64, 128, 256}

func main() {
	src := "assets/icon_1024.png"
	out := "assets/app.ico"

	srcImg, err := imaging.Open(src)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	var entries [][]byte
	for _, size := range sizes {
		// Lanczos resampling keeps edges smooth; step down through 256 for
		// the small sizes so the filter has enough support to work with.
		img := srcImg
		if size < 256 {
			img = imaging.Resize(img, 256, 256, imaging.Lanczos)
		}
		scaled := imaging.Resize(img, size, size, imaging.Lanczos)

		var buf bytes.Buffer
		if err := png.Encode(&buf, scaled); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		entries = append(entries, buf.Bytes())
	}

	ico := buildICO(entries)
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(out, ico, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %s (%d bytes, sizes %v)\n", out, len(ico), sizes)
}

func buildICO(entries [][]byte) []byte {
	var buf bytes.Buffer
	// ICONDIR: reserved, type (1 = icon), count.
	binary.Write(&buf, binary.LittleEndian, uint16(0))
	binary.Write(&buf, binary.LittleEndian, uint16(1))
	binary.Write(&buf, binary.LittleEndian, uint16(len(entries)))

	dataStart := 6 + 16*len(entries)
	offset := dataStart
	for i, e := range entries {
		size := sizes[i]
		w, h := byte(size), byte(size)
		if size >= 256 {
			w, h = 0, 0 // 0 means 256 in ICO entries
		}
		buf.WriteByte(w)
		buf.WriteByte(h)
		buf.WriteByte(0) // palette count
		buf.WriteByte(0) // reserved
		binary.Write(&buf, binary.LittleEndian, uint16(1))  // planes
		binary.Write(&buf, binary.LittleEndian, uint16(32)) // bit count
		binary.Write(&buf, binary.LittleEndian, uint32(len(e)))
		binary.Write(&buf, binary.LittleEndian, uint32(offset))
		offset += len(e)
	}
	for _, e := range entries {
		buf.Write(e)
	}
	return buf.Bytes()
}
