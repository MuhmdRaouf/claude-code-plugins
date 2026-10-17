// Package archtest enforces the engine's import-direction rule (ARCHITECTURE.md, Code structure).
package archtest

import (
	"fmt"
	"strings"
)

const modulePath = "github.com/MuhmdRaouf/claude-code-plugins/packages/core"

type Layer string

const (
	LayerDomain    Layer = "domain"
	LayerPorts     Layer = "ports"
	LayerApp       Layer = "app"
	LayerAdapters  Layer = "adapters"
	LayerRender    Layer = "render"
	LayerAuthpage  Layer = "authpage"
	LayerRouter    Layer = "router"
	LayerProviders Layer = "providers"
	LayerCli       Layer = "cli"
	LayerTestkit   Layer = "testkit"
	LayerArchtest  Layer = "archtest"
	LayerCmd       Layer = "cmd"
	LayerScripts   Layer = "scripts"
)

// FileImports is one non-test Go file's layer and import list.
type FileImports struct {
	File    string
	Layer   Layer
	Imports []string
}

// allowedLayers lists the module-internal layers each layer may import.
var allowedLayers = map[Layer][]Layer{
	LayerDomain:    {LayerDomain},
	LayerPorts:     {LayerDomain},
	LayerApp:       {LayerDomain, LayerPorts},
	LayerAdapters:  {LayerDomain, LayerPorts, LayerAdapters},
	LayerRender:    {LayerDomain, LayerPorts, LayerApp, LayerRender},
	LayerAuthpage:  {LayerDomain, LayerPorts, LayerAdapters},
	LayerRouter:    {LayerDomain, LayerPorts, LayerAdapters, LayerRouter},
	LayerProviders: {LayerDomain},
	LayerCli: {
		LayerDomain, LayerPorts, LayerApp, LayerAdapters, LayerRender,
		LayerAuthpage, LayerRouter, LayerProviders, LayerCli,
	},
	LayerCmd:      {LayerCli, LayerRouter, LayerProviders, LayerDomain},
	LayerTestkit:  {LayerDomain, LayerPorts, LayerApp, LayerAdapters, LayerRender, LayerAuthpage, LayerRouter, LayerProviders, LayerTestkit},
	LayerArchtest: {},
	LayerScripts:  {},
}

// allowedThirdParty is the closed set of non-standard modules any file may import;
// domain is restricted further to domainThirdParty.
var allowedThirdParty = []string{
	"gopkg.in/yaml.v3",
	"github.com/bmatcuk/doublestar/v4",
	"github.com/andybalholm/brotli",
}

var domainThirdParty = []string{
	"gopkg.in/yaml.v3",
	"github.com/bmatcuk/doublestar/v4",
}

// classify maps a slash package directory, relative to the module root, to its layer.
func classify(dir string) (Layer, bool) {
	exact := map[string]Layer{
		"internal/ports":     LayerPorts,
		"internal/app":       LayerApp,
		"internal/render":    LayerRender,
		"internal/authpage":  LayerAuthpage,
		"internal/router":    LayerRouter,
		"internal/cli":       LayerCli,
		"internal/providers": LayerProviders,
		"internal/archtest":  LayerArchtest,
	}
	if layer, ok := exact[dir]; ok {
		return layer, true
	}
	nested := []struct {
		prefix string
		layer  Layer
	}{
		{"internal/domain", LayerDomain},
		{"internal/adapters", LayerAdapters},
		{"internal/testkit", LayerTestkit},
		{"cmd", LayerCmd},
		{"scripts", LayerScripts},
	}
	for _, n := range nested {
		if under(dir, n.prefix) {
			return n.layer, true
		}
	}
	return "", false
}

// Check returns every layer-rule violation, formatted "<file>: <layer> must not import <path>".
func Check(files []FileImports) []string {
	var messages []string
	for _, f := range files {
		for _, imp := range f.Imports {
			if !allowed(f, imp) {
				messages = append(messages, fmt.Sprintf("%s: %s must not import %s", f.File, f.Layer, imp))
			}
		}
	}
	return messages
}

func allowed(f FileImports, imp string) bool {
	if rel, ok := internalPackage(imp); ok {
		layer, ok := classify(rel)
		if !ok {
			return false
		}
		return contains(allowedLayers[f.Layer], layer)
	}
	if isStandard(imp) {
		return true
	}
	allowedSets := [][]string{allowedThirdParty}
	if f.Layer == LayerDomain {
		allowedSets = [][]string{domainThirdParty}
	}
	for _, set := range allowedSets {
		for _, allowedModule := range set {
			if imp == allowedModule || strings.HasPrefix(imp, allowedModule+"/") {
				return true
			}
		}
	}
	return false
}

// internalPackage strips the module prefix, returning the package's directory
// relative to the module root.
func internalPackage(imp string) (string, bool) {
	if !strings.HasPrefix(imp, modulePath+"/") {
		return "", false
	}
	return strings.TrimPrefix(imp, modulePath+"/"), true
}

// isStandard reports whether the import path is in the standard library:
// standard-library paths have no dot in their first segment.
func isStandard(imp string) bool {
	first := imp
	if i := strings.IndexByte(imp, '/'); i >= 0 {
		first = imp[:i]
	}
	return !strings.ContainsRune(first, '.')
}

func under(path, prefix string) bool {
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

func contains(list []Layer, want Layer) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
