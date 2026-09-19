//go:build !(linux || darwin || freebsd)

package bench

func cpuMs() *float64    { return nil }
func peakMemory() *int64 { return nil }
