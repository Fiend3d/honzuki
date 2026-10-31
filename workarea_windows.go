//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	user32            = syscall.NewLazyDLL("user32.dll")
	gdi32             = syscall.NewLazyDLL("gdi32.dll")
	procSysParamInfo  = user32.NewProc("SystemParametersInfoW")
	procGetDC         = user32.NewProc("GetDC")
	procReleaseDC     = user32.NewProc("ReleaseDC")
	procGetDeviceCaps = gdi32.NewProc("GetDeviceCaps")
)

// SPI_GETWORKAREA: work area of the primary screen, excluding the taskbar,
// in physical pixels. LOGPIXELSX/Y: primary display DPI.
const (
	spiGetWorkArea = 0x0003
	logPixelX      = 88
	logPixelY      = 90
)

// primaryWorkArea returns the primary screen's work area in DIP pixels -
// the same unit WebviewWindowOptions.Width/Height use. It asks the OS
// directly because app.Screen is only populated once app.Run has started,
// which is after the window options have already been read.
func primaryWorkArea() (int, int, bool) {
	var rect [4]int32 // left, top, right, bottom
	r, _, err := procSysParamInfo.Call(spiGetWorkArea, 0, uintptr(unsafe.Pointer(&rect)), 0)
	if r == 0 {
		return 0, 0, false
	}
	_ = err
	w := int(rect[2]) - int(rect[0])
	h := int(rect[3]) - int(rect[1])
	if w <= 0 || h <= 0 {
		return 0, 0, false
	}

	// Convert physical pixels to DIPs using the primary display's DPI.
	hdc, _, _ := procGetDC.Call(0)
	if hdc == 0 {
		return w, h, true // No DC available: assume 96 DPI (100% scaling).
	}
	dpiX, _, _ := procGetDeviceCaps.Call(hdc, logPixelX)
	dpiY, _, _ := procGetDeviceCaps.Call(hdc, logPixelY)
	procReleaseDC.Call(0, hdc)
	if dpiX == 0 || dpiY == 0 {
		return w, h, true
	}
	return int(w) * 96 / int(dpiX), int(h) * 96 / int(dpiY), true
}
