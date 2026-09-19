//go:build linux || darwin || freebsd

package bench

import (
	"runtime"
	"syscall"
)

func rusage() *syscall.Rusage {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return nil
	}
	return &ru
}

func cpuMs() *float64 {
	ru := rusage()
	if ru == nil {
		return nil
	}
	ms := float64(ru.Utime.Nano()+ru.Stime.Nano()) / 1e6
	return &ms
}

func peakMemory() *int64 {
	ru := rusage()
	if ru == nil {
		return nil
	}
	b := int64(ru.Maxrss)
	if runtime.GOOS != "darwin" { // darwin reports bytes, others KiB
		b *= 1024
	}
	return &b
}
