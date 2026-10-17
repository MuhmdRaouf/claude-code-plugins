// Package localca keeps the per-user certificate authority that lets a provider router stand in for
// api.anthropic.com when Claude Code reaches it through HTTPS_PROXY. Claude Code trusts the CA only through
// NODE_EXTRA_CA_CERTS in its settings; it is never added to a system trust store.
//
// The CA carries a critical name constraint for api.anthropic.com, so even a leaked key cannot sign a
// certificate any client accepts for another host.
package localca

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// Host is the one name the CA signs for.
const Host = "api.anthropic.com"

const (
	keyFile  = "ca.key"
	certFile = "ca.pem"
	caLife   = 10 * 365 * 24 * time.Hour
	leafLife = 7 * 24 * time.Hour
	// A CA this close to expiry is replaced, so no leaf outlives it.
	renewBefore = leafLife + 24*time.Hour
)

// CA is a loaded certificate authority.
type CA struct {
	cert     *x509.Certificate
	certPEM  []byte
	key      *ecdsa.PrivateKey
	certPath string
}

// InsecureError means the CA's files can be read or replaced by another user; the CA is not used.
type InsecureError struct {
	Path   string
	Reason string
}

func (e *InsecureError) Error() string { return fmt.Sprintf("local CA %s: %s", e.Path, e.Reason) }

// InvalidError means ca.key does not hold a CA this package made.
type InvalidError struct {
	Path   string
	Reason string
}

func (e *InvalidError) Error() string { return fmt.Sprintf("local CA %s: %s", e.Path, e.Reason) }

// LoadOrCreate returns the CA kept in dir, creating it on first use. Five routers may call it at once: the
// first to link its ca.key wins and the others load that one.
func LoadOrCreate(ctx context.Context, dir string, now time.Time) (*CA, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := checkOwnedPrivate(dir, 0o022); err != nil {
		return nil, err
	}
	keyPath := filepath.Join(dir, keyFile)
	ca, err := load(keyPath)
	if errors.Is(err, fs.ErrNotExist) {
		ca, err = create(dir, keyPath, now)
	}
	if err != nil {
		return nil, err
	}
	if ca.cert.NotAfter.Sub(now) < renewBefore {
		if ca, err = replace(dir, keyPath, now); err != nil {
			return nil, err
		}
	}
	ca.certPath = filepath.Join(dir, certFile)
	if err := ensureCertFile(dir, ca); err != nil {
		return nil, err
	}
	return ca, nil
}

// CertPath is the PEM file NODE_EXTRA_CA_CERTS names.
func (c *CA) CertPath() string { return c.certPath }

// CertPEM is the CA certificate in PEM form.
func (c *CA) CertPEM() []byte { return c.certPEM }

// Certificate is the parsed CA certificate.
func (c *CA) Certificate() *x509.Certificate { return c.cert }

// Leaf signs a short-lived server certificate for host, which must be Host.
func (c *CA) Leaf(host string, now time.Time) (*tls.Certificate, error) {
	if host != Host {
		return nil, fmt.Errorf("local CA signs only %s, not %q", Host, host)
	}
	key := must(ecdsa.GenerateKey(elliptic.P256(), rand.Reader))
	notAfter := now.Add(leafLife)
	if notAfter.After(c.cert.NotAfter) {
		notAfter = c.cert.NotAfter
	}
	template := &x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: Host},
		DNSNames:     []string{Host},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der := must(x509.CreateCertificate(rand.Reader, template, c.cert, &key.PublicKey, c.key))
	leaf := must(x509.ParseCertificate(der))
	return &tls.Certificate{Certificate: [][]byte{der, c.cert.Raw}, PrivateKey: key, Leaf: leaf}, nil
}

// load reads ca.key: the PEM private key followed by the CA certificate.
func load(keyPath string) (*CA, error) {
	if err := checkOwnedPrivate(keyPath, 0o077); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, err
	}
	invalid := func(reason string) error { return &InvalidError{Path: keyPath, Reason: reason} }
	keyBlock, rest := pem.Decode(data)
	if keyBlock == nil || keyBlock.Type != "EC PRIVATE KEY" {
		return nil, invalid("no EC private key")
	}
	certBlock, _ := pem.Decode(rest)
	if certBlock == nil || certBlock.Type != "CERTIFICATE" {
		return nil, invalid("no certificate after the key")
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, invalid(err.Error())
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, invalid(err.Error())
	}
	if !cert.IsCA || !cert.PermittedDNSDomainsCritical || len(cert.PermittedDNSDomains) != 1 ||
		cert.PermittedDNSDomains[0] != Host {
		return nil, invalid("not a CA constrained to " + Host)
	}
	if !key.PublicKey.Equal(cert.PublicKey) {
		return nil, invalid("the key does not match the certificate")
	}
	return &CA{cert: cert, key: key, certPEM: pem.EncodeToMemory(certBlock)}, nil
}

func create(dir, keyPath string, now time.Time) (*CA, error) {
	tmp, err := writeTemp(dir, generate(now), 0o600)
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp)
	// A hard link never replaces an existing file, so exactly one concurrent creator wins.
	if err := os.Link(tmp, keyPath); err != nil && !errors.Is(err, fs.ErrExist) {
		return nil, err
	}
	return load(keyPath)
}

// replace swaps an expiring CA for a new one. Claude Code sessions started before the swap keep trusting the
// old certificate until they restart, so this happens only near the end of a ten-year life.
func replace(dir, keyPath string, now time.Time) (*CA, error) {
	tmp, err := writeTemp(dir, generate(now), 0o600)
	if err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, keyPath); err != nil {
		os.Remove(tmp)
		return nil, err
	}
	return load(keyPath)
}

// generate makes a new CA key and certificate. P-256 key generation, self-signing a well-formed template and
// marshalling a P-256 key cannot fail, so a failure there is a broken runtime and panics.
func generate(now time.Time) []byte {
	key := must(ecdsa.GenerateKey(elliptic.P256(), rand.Reader))
	template := &x509.Certificate{
		SerialNumber:                serial(),
		Subject:                     pkix.Name{CommonName: "cc-plugins local CA for " + Host},
		NotBefore:                   now.Add(-time.Hour),
		NotAfter:                    now.Add(caLife),
		IsCA:                        true,
		BasicConstraintsValid:       true,
		MaxPathLenZero:              true,
		KeyUsage:                    x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         []string{Host},
	}
	der := must(x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key))
	var out bytes.Buffer
	_ = pem.Encode(&out, &pem.Block{Type: "EC PRIVATE KEY", Bytes: must(x509.MarshalECPrivateKey(key))})
	_ = pem.Encode(&out, &pem.Block{Type: "CERTIFICATE", Bytes: der})
	return out.Bytes()
}

// writeTemp writes data to a new temporary file in dir with the given mode and returns its name.
func writeTemp(dir string, data []byte, mode os.FileMode) (string, error) {
	f, err := os.CreateTemp(dir, ".ca-*.tmp")
	if err != nil {
		return "", err
	}
	name := f.Name()
	err = f.Chmod(mode)
	if err == nil {
		_, err = f.Write(data)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(name)
		return "", err
	}
	return name, nil
}

// ensureCertFile writes ca.pem from the key file when it is missing or differs.
func ensureCertFile(dir string, ca *CA) error {
	if current, err := os.ReadFile(ca.certPath); err == nil && bytes.Equal(current, ca.certPEM) {
		return nil
	}
	tmp, err := writeTemp(dir, ca.certPEM, 0o644)
	if err != nil {
		return err
	}
	if err := os.Rename(tmp, ca.certPath); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// checkOwnedPrivate refuses a path another user owns or whose mode has any of the forbidden bits.
func checkOwnedPrivate(path string, forbidden os.FileMode) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return &InsecureError{Path: path, Reason: "is a symbolic link"}
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Getuid() {
		return &InsecureError{Path: path, Reason: "owned by another user"}
	}
	if info.Mode().Perm()&forbidden != 0 {
		return &InsecureError{Path: path, Reason: fmt.Sprintf("mode %o lets other users in", info.Mode().Perm())}
	}
	return nil
}

func serial() *big.Int {
	return must(rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127)))
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
