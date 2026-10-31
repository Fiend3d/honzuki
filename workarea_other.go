//go:build !windows

package main

// primaryWorkArea has no cheap cross-platform answer here; the WindowLoaded
// safety net in main.go clamps with app.Screen once it is populated.
func primaryWorkArea() (int, int, bool) {
	return 0, 0, false
}
