package engine

import (
	"crypto/rand"
	"encoding/binary"
	"regexp"
	"strings"
	"time"
)

// ReplayAlphabet is the replay-code alphabet (SPEC §9).
const ReplayAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// RandomSeed returns a uint32 seed from a CSPRNG.
func RandomSeed() uint32 { return binary.LittleEndian.Uint32(randomBytes(4)) }

// ULID returns a new ULID for the given time.
func ULID(now time.Time) string {
	t := uint64(now.UnixMilli())
	var out [26]byte
	for i := 9; i >= 0; i-- {
		out[i] = crockford[t%32]
		t /= 32
	}
	rnd := randomBytes(16)
	for i := 0; i < 16; i++ {
		out[10+i] = crockford[rnd[i]&31]
	}
	return string(out[:])
}

var ulidRe = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)

// IsULID reports whether s is a ULID.
func IsULID(s string) bool { return ulidRe.MatchString(s) }

// GenerateReplayCode returns a new formatted replay code.
func GenerateReplayCode() string {
	rnd := randomBytes(12)
	var s [12]byte
	for i := range s {
		s[i] = ReplayAlphabet[rnd[i]&31]
	}
	return FormatReplayCode(string(s[:]))
}

// NormalizeReplayCode upper-cases, strips non [A-Z0-9], and validates.
func NormalizeReplayCode(input string) (string, bool) {
	var sb strings.Builder
	for _, c := range strings.ToUpper(input) {
		if (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			sb.WriteRune(c)
		}
	}
	s := sb.String()
	if len(s) != 12 {
		return "", false
	}
	for i := 0; i < 12; i++ {
		if strings.IndexByte(ReplayAlphabet, s[i]) < 0 {
			return "", false
		}
	}
	return s, true
}

// FormatReplayCode inserts dashes: XXXX-XXXX-XXXX.
func FormatReplayCode(n string) string { return n[0:4] + "-" + n[4:8] + "-" + n[8:12] }
