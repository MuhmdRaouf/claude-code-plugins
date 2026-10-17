package localca_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/localca"
)

var now = time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)

func load(t *testing.T, dir string) *localca.CA {
	t.Helper()
	ca, err := localca.LoadOrCreate(context.Background(), dir, now)
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	return ca
}

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

func TestCreatesThePrivateKeyOwnerOnlyAndTheCertificateReadable(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ca")
	ca := load(t, dir)
	if got := mode(t, dir); got != 0o700 {
		t.Errorf("dir mode %o, want 700", got)
	}
	if got := mode(t, filepath.Join(dir, "ca.key")); got != 0o600 {
		t.Errorf("ca.key mode %o, want 600", got)
	}
	if got := mode(t, filepath.Join(dir, "ca.pem")); got != 0o644 {
		t.Errorf("ca.pem mode %o, want 644", got)
	}
	if ca.CertPath() != filepath.Join(dir, "ca.pem") {
		t.Errorf("CertPath %q", ca.CertPath())
	}
	pem, err := os.ReadFile(ca.CertPath())
	if err != nil {
		t.Fatal(err)
	}
	if string(pem) != string(ca.CertPEM()) {
		t.Error("ca.pem does not hold the CA certificate")
	}
	for _, word := range []string{"PRIVATE KEY"} {
		if contains(pem, word) {
			t.Errorf("ca.pem holds %q", word)
		}
	}
}

func contains(b []byte, s string) bool {
	return len(s) > 0 && len(b) >= len(s) && (string(b) == s || indexOf(string(b), s) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestTheCaCanSignOnlyTheAnthropicApiHost(t *testing.T) {
	ca := load(t, t.TempDir())
	cert := ca.Certificate()
	if !cert.IsCA || !cert.PermittedDNSDomainsCritical {
		t.Fatalf("IsCA=%v critical=%v", cert.IsCA, cert.PermittedDNSDomainsCritical)
	}
	if len(cert.PermittedDNSDomains) != 1 || cert.PermittedDNSDomains[0] != localca.Host {
		t.Fatalf("permitted %v", cert.PermittedDNSDomains)
	}
	if _, err := ca.Leaf("evil.example.com", now); err == nil {
		t.Fatal("signed a leaf for another host")
	}
}

func TestTheLeafVerifiesAgainstTheCaForTheApiHostOnly(t *testing.T) {
	ca := load(t, t.TempDir())
	leaf, err := ca.Leaf(localca.Host, now)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca.Certificate())
	cert := leaf.Leaf
	if _, err := cert.Verify(x509.VerifyOptions{DNSName: localca.Host, Roots: roots, CurrentTime: now}); err != nil {
		t.Fatalf("leaf does not verify: %v", err)
	}
	if _, err := cert.Verify(x509.VerifyOptions{DNSName: "claude.ai", Roots: roots, CurrentTime: now}); err == nil {
		t.Fatal("leaf verifies for claude.ai")
	}
	if cert.NotAfter.Sub(now) > 8*24*time.Hour {
		t.Errorf("leaf lives until %v; want at most a week", cert.NotAfter)
	}
}

func TestTheLeafServesATlsHandshake(t *testing.T) {
	ca := load(t, t.TempDir())
	leaf, err := ca.Leaf(localca.Host, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca.Certificate())
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{*leaf}})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			_ = c.(*tls.Conn).Handshake()
			c.Close()
		}
	}()
	c, err := tls.Dial("tcp", ln.Addr().String(), &tls.Config{RootCAs: roots, ServerName: localca.Host})
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	c.Close()
}

func TestASecondLoadReturnsTheSameCa(t *testing.T) {
	dir := t.TempDir()
	first := load(t, dir)
	second := load(t, dir)
	if string(first.CertPEM()) != string(second.CertPEM()) {
		t.Fatal("a second load made a new CA")
	}
}

func TestConcurrentRoutersAgreeOnOneCa(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ca")
	var wg sync.WaitGroup
	pems := make([]string, 5)
	errs := make([]error, 5)
	for i := range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ca, err := localca.LoadOrCreate(context.Background(), dir, now)
			errs[i] = err
			if err == nil {
				pems[i] = string(ca.CertPEM())
			}
		}()
	}
	wg.Wait()
	for i := range 5 {
		if errs[i] != nil {
			t.Fatalf("router %d: %v", i, errs[i])
		}
		if pems[i] != pems[0] {
			t.Fatalf("router %d got a different CA", i)
		}
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("dir holds %v; want ca.key and ca.pem only", names)
	}
}

func TestRefusesAKeyOthersCanRead(t *testing.T) {
	dir := t.TempDir()
	load(t, dir)
	if err := os.Chmod(filepath.Join(dir, "ca.key"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := localca.LoadOrCreate(context.Background(), dir, now)
	var insecure *localca.InsecureError
	if !errors.As(err, &insecure) {
		t.Fatalf("err = %v, want InsecureError", err)
	}
}

func TestRefusesADirectoryOthersCanWrite(t *testing.T) {
	dir := t.TempDir()
	load(t, dir)
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	_, err := localca.LoadOrCreate(context.Background(), dir, now)
	var insecure *localca.InsecureError
	if !errors.As(err, &insecure) {
		t.Fatalf("err = %v, want InsecureError", err)
	}
}

func TestRefusesAKeyFileThatIsNotACa(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ca.key"), []byte("not pem"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := localca.LoadOrCreate(context.Background(), dir, now)
	var invalid *localca.InvalidError
	if !errors.As(err, &invalid) {
		t.Fatalf("err = %v, want InvalidError", err)
	}
}

func TestRewritesAMissingOrChangedCertificateFile(t *testing.T) {
	dir := t.TempDir()
	ca := load(t, dir)
	pemPath := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(pemPath, []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	load(t, dir)
	got, _ := os.ReadFile(pemPath)
	if string(got) != string(ca.CertPEM()) {
		t.Fatal("ca.pem was not restored from the key file")
	}
	os.Remove(pemPath)
	load(t, dir)
	if _, err := os.Stat(pemPath); err != nil {
		t.Fatal("ca.pem was not recreated")
	}
}

func TestReplacesAnExpiredCa(t *testing.T) {
	dir := t.TempDir()
	old := load(t, dir)
	later := old.Certificate().NotAfter.Add(time.Hour)
	fresh, err := localca.LoadOrCreate(context.Background(), dir, later)
	if err != nil {
		t.Fatal(err)
	}
	if string(fresh.CertPEM()) == string(old.CertPEM()) {
		t.Fatal("an expired CA was kept")
	}
	if fresh.Certificate().NotAfter.Before(later) {
		t.Fatal("the new CA is already expired")
	}
}

func TestRefusesASymlinkedKey(t *testing.T) {
	dir := t.TempDir()
	load(t, dir)
	key := filepath.Join(dir, "ca.key")
	if err := os.Rename(key, filepath.Join(dir, "real.key")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "real.key"), key); err != nil {
		t.Fatal(err)
	}
	_, err := localca.LoadOrCreate(context.Background(), dir, now)
	var insecure *localca.InsecureError
	if !errors.As(err, &insecure) || insecure.Error() == "" {
		t.Fatalf("err = %v, want InsecureError", err)
	}
}

func TestRefusesKeyFilesThatAreNotThisCa(t *testing.T) {
	other := t.TempDir()
	load(t, other)
	otherKey, _ := os.ReadFile(filepath.Join(other, "ca.key"))
	keyOnly := otherKey[:indexOf(string(otherKey), "-----BEGIN CERTIFICATE-----")]
	certOnly := otherKey[len(keyOnly):]
	mine := t.TempDir()
	load(t, mine)
	mineKey, _ := os.ReadFile(filepath.Join(mine, "ca.key"))
	mineKeyOnly := mineKey[:indexOf(string(mineKey), "-----BEGIN CERTIFICATE-----")]
	cases := map[string][]byte{
		"key without certificate": keyOnly,
		"certificate first":       append(append([]byte{}, certOnly...), keyOnly...),
		"key of another CA":       append(append([]byte{}, mineKeyOnly...), certOnly...),
		"bad key bytes":           []byte("-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n"),
		"bad certificate bytes": append(append([]byte{}, keyOnly...),
			[]byte("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n")...),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "ca.key"), data, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := localca.LoadOrCreate(context.Background(), dir, now)
			var invalid *localca.InvalidError
			if !errors.As(err, &invalid) || invalid.Error() == "" {
				t.Fatalf("err = %v, want InvalidError", err)
			}
		})
	}
}

func TestRefusesACertificateThatIsNotAConstrainedCa(t *testing.T) {
	dir := t.TempDir()
	ca := load(t, dir)
	leaf, err := ca.Leaf(localca.Host, now)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(leaf.PrivateKey.(*ecdsa.PrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	data := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	data = append(data, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leaf.Certificate[0]})...)
	if err := os.WriteFile(filepath.Join(dir, "ca.key"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = localca.LoadOrCreate(context.Background(), dir, now)
	var invalid *localca.InvalidError
	if !errors.As(err, &invalid) {
		t.Fatalf("err = %v, want InvalidError", err)
	}
}

func TestStopsOnACancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := localca.LoadOrCreate(ctx, t.TempDir(), now); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

func TestReportsADirectoryItCannotWrite(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "ca")
	load(t, dir)
	if err := os.Remove(filepath.Join(dir, "ca.pem")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	if _, err := localca.LoadOrCreate(context.Background(), dir, now); err == nil {
		t.Fatal("restored ca.pem in a read-only directory")
	}
	empty := filepath.Join(parent, "empty")
	if err := os.Mkdir(empty, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(empty, 0o700) })
	if _, err := localca.LoadOrCreate(context.Background(), empty, now); err == nil {
		t.Fatal("created a CA in a read-only directory")
	}
	if _, err := localca.LoadOrCreate(context.Background(), filepath.Join(empty, "sub"), now); err == nil {
		t.Fatal("created a directory under a read-only one")
	}
}

func TestReportsAnExpiredCaItCannotReplace(t *testing.T) {
	dir := t.TempDir()
	old := load(t, dir)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	if _, err := localca.LoadOrCreate(context.Background(), dir, old.Certificate().NotAfter); err == nil {
		t.Fatal("replaced a CA in a read-only directory")
	}
}

func TestTheLastLeafEndsWithTheCa(t *testing.T) {
	ca := load(t, t.TempDir())
	end := ca.Certificate().NotAfter
	leaf, err := ca.Leaf(localca.Host, end.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !leaf.Leaf.NotAfter.Equal(end) {
		t.Fatalf("leaf ends %v, CA ends %v", leaf.Leaf.NotAfter, end)
	}
}
