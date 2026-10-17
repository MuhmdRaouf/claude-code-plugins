package archtest

import (
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"path"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func mp(segments ...string) string {
	return modulePath + "/" + strings.Join(segments, "/")
}

func TestCheckReportsEveryViolation(t *testing.T) {
	files := []FileImports{
		// Every layer's allowed imports, module-internal and third-party.
		{File: "internal/domain/a/a.go", Layer: LayerDomain, Imports: []string{
			"fmt", "gopkg.in/yaml.v3", "github.com/bmatcuk/doublestar/v4", mp("internal/domain/b"),
		}},
		{File: "internal/ports/ports.go", Layer: LayerPorts, Imports: []string{mp("internal/domain/b")}},
		{File: "internal/app/app.go", Layer: LayerApp, Imports: []string{mp("internal/domain/b"), mp("internal/ports")}},
		{File: "internal/adapters/a/a.go", Layer: LayerAdapters, Imports: []string{
			mp("internal/domain/b"), mp("internal/ports"), mp("internal/adapters/c"), "github.com/bmatcuk/doublestar/v4",
		}},
		{File: "internal/render/render.go", Layer: LayerRender, Imports: []string{
			mp("internal/domain/b"), mp("internal/ports"), mp("internal/app"), mp("internal/render"),
		}},
		{File: "internal/authpage/authpage.go", Layer: LayerAuthpage, Imports: []string{
			mp("internal/domain/b"), mp("internal/ports"), mp("internal/adapters/c"),
		}},
		{File: "internal/router/router.go", Layer: LayerRouter, Imports: []string{
			mp("internal/domain/b"), mp("internal/ports"), mp("internal/adapters/c"), mp("internal/router"),
		}},
		{File: "internal/providers/providers.go", Layer: LayerProviders, Imports: []string{mp("internal/domain/b")}},
		{File: "internal/cli/cli.go", Layer: LayerCli, Imports: []string{
			mp("internal/domain/b"), mp("internal/ports"), mp("internal/app"), mp("internal/adapters/c"),
			mp("internal/render"), mp("internal/authpage"), mp("internal/router"), mp("internal/providers"),
			mp("internal/cli"), "gopkg.in/yaml.v3",
		}},
		{File: "cmd/plugin-core/main.go", Layer: LayerCmd, Imports: []string{
			mp("internal/cli"), mp("internal/router"), mp("internal/providers"), mp("internal/domain/b"),
		}},
		{File: "internal/testkit/testkit.go", Layer: LayerTestkit, Imports: []string{
			mp("internal/domain/b"), mp("internal/ports"), mp("internal/app"), mp("internal/adapters/c"),
			mp("internal/render"), mp("internal/authpage"), mp("internal/router"), mp("internal/providers"),
			mp("internal/testkit/builder"),
		}},
		{File: "internal/archtest/archtest.go", Layer: LayerArchtest, Imports: []string{"go/parser"}},
		{File: "scripts/covergate/main.go", Layer: LayerScripts, Imports: []string{"fmt"}},

		// Violations: one per forbidden edge.
		{File: "bad/ports.go", Layer: LayerPorts, Imports: []string{mp("internal/ports")}},
		{File: "bad/ports_thirdparty.go", Layer: LayerPorts, Imports: []string{"github.com/spf13/cobra"}},
		{File: "bad/app_adapters.go", Layer: LayerApp, Imports: []string{mp("internal/adapters/c")}},
		{File: "bad/app_app.go", Layer: LayerApp, Imports: []string{mp("internal/app/other")}},
		{File: "bad/adapters_app.go", Layer: LayerAdapters, Imports: []string{mp("internal/app")}},
		{File: "bad/render_authpage.go", Layer: LayerRender, Imports: []string{mp("internal/authpage")}},
		{File: "bad/authpage_render.go", Layer: LayerAuthpage, Imports: []string{mp("internal/render")}},
		{File: "bad/router_render.go", Layer: LayerRouter, Imports: []string{mp("internal/render")}},
		{File: "bad/providers_ports.go", Layer: LayerProviders, Imports: []string{mp("internal/ports")}},
		{File: "bad/providers_thirdparty.go", Layer: LayerProviders, Imports: []string{"github.com/spf13/cobra"}},
		{File: "bad/cli_cmd.go", Layer: LayerCli, Imports: []string{mp("cmd/plugin-core")}},
		{File: "bad/cli_testkit.go", Layer: LayerCli, Imports: []string{mp("internal/testkit")}},
		{File: "bad/cli_scripts.go", Layer: LayerCli, Imports: []string{mp("scripts/covergate")}},
		{File: "bad/cmd_app.go", Layer: LayerCmd, Imports: []string{mp("internal/app")}},
		{File: "bad/cmd_ports.go", Layer: LayerCmd, Imports: []string{mp("internal/ports")}},
		{File: "bad/testkit_cli.go", Layer: LayerTestkit, Imports: []string{mp("internal/cli")}},
		{File: "bad/testkit_cmd.go", Layer: LayerTestkit, Imports: []string{mp("cmd/plugin-core")}},
		{File: "bad/testkit_scripts.go", Layer: LayerTestkit, Imports: []string{mp("scripts/covergate")}},
		{File: "bad/domain_sys.go", Layer: LayerDomain, Imports: []string{"golang.org/x/sys/unix"}},
		{File: "bad/domain_unknown.go", Layer: LayerDomain, Imports: []string{"github.com/spf13/cobra"}},
		{File: "bad/domain_router.go", Layer: LayerDomain, Imports: []string{mp("internal/router")}},
		{File: "bad/adapters_thirdparty.go", Layer: LayerAdapters, Imports: []string{"github.com/spf13/cobra"}},
		{File: "bad/archtest_domain.go", Layer: LayerArchtest, Imports: []string{mp("internal/domain/b")}},
		{File: "bad/scripts_domain.go", Layer: LayerScripts, Imports: []string{mp("internal/domain/b")}},
	}

	want := []string{
		"bad/ports.go: ports must not import " + mp("internal/ports"),
		"bad/ports_thirdparty.go: ports must not import github.com/spf13/cobra",
		"bad/app_adapters.go: app must not import " + mp("internal/adapters/c"),
		"bad/app_app.go: app must not import " + mp("internal/app/other"),
		"bad/adapters_app.go: adapters must not import " + mp("internal/app"),
		"bad/render_authpage.go: render must not import " + mp("internal/authpage"),
		"bad/authpage_render.go: authpage must not import " + mp("internal/render"),
		"bad/router_render.go: router must not import " + mp("internal/render"),
		"bad/providers_ports.go: providers must not import " + mp("internal/ports"),
		"bad/providers_thirdparty.go: providers must not import github.com/spf13/cobra",
		"bad/cli_cmd.go: cli must not import " + mp("cmd/plugin-core"),
		"bad/cli_testkit.go: cli must not import " + mp("internal/testkit"),
		"bad/cli_scripts.go: cli must not import " + mp("scripts/covergate"),
		"bad/cmd_app.go: cmd must not import " + mp("internal/app"),
		"bad/cmd_ports.go: cmd must not import " + mp("internal/ports"),
		"bad/testkit_cli.go: testkit must not import " + mp("internal/cli"),
		"bad/testkit_cmd.go: testkit must not import " + mp("cmd/plugin-core"),
		"bad/testkit_scripts.go: testkit must not import " + mp("scripts/covergate"),
		"bad/domain_sys.go: domain must not import golang.org/x/sys/unix",
		"bad/domain_unknown.go: domain must not import github.com/spf13/cobra",
		"bad/domain_router.go: domain must not import " + mp("internal/router"),
		"bad/adapters_thirdparty.go: adapters must not import github.com/spf13/cobra",
		"bad/archtest_domain.go: archtest must not import " + mp("internal/domain/b"),
		"bad/scripts_domain.go: scripts must not import " + mp("internal/domain/b"),
	}

	got := Check(files)
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Check() =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestCheckCleanListHasNoViolations(t *testing.T) {
	files := []FileImports{
		{File: "internal/domain/b/b.go", Layer: LayerDomain, Imports: []string{"fmt", "gopkg.in/yaml.v3"}},
		{File: "internal/app/app.go", Layer: LayerApp, Imports: []string{mp("internal/domain/b"), mp("internal/ports")}},
		{File: "cmd/plugin-core/main.go", Layer: LayerCmd, Imports: []string{mp("internal/cli")}},
		{File: "internal/router/upstream.go", Layer: LayerRouter, Imports: []string{"github.com/andybalholm/brotli"}},
	}
	if got := Check(files); len(got) != 0 {
		t.Errorf("Check() = %v, want no violations", got)
	}
}

func TestTreeFollowsTheLayerRule(t *testing.T) {
	files, err := walkTree()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no non-test Go files found under internal/ or cmd/")
	}
	for _, msg := range Check(files) {
		t.Error(msg)
	}
}

// walkTree collects FileImports for every non-test .go file under internal/ and cmd/.
func walkTree() ([]FileImports, error) {
	const root = "../.."
	var files []FileImports
	for _, dir := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(d.Name(), ".go") || strings.HasSuffix(d.Name(), "_test.go") {
				return nil
			}
			rel, err := filepath.Rel(root, p)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			layer, ok := classify(path.Dir(rel))
			if !ok {
				return fmt.Errorf("%s: cannot classify package layer", rel)
			}
			fset := token.NewFileSet()
			parsed, err := parser.ParseFile(fset, p, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			imports := make([]string, 0, len(parsed.Imports))
			for _, imp := range parsed.Imports {
				value, err := strconv.Unquote(imp.Path.Value)
				if err != nil {
					return err
				}
				imports = append(imports, value)
			}
			files = append(files, FileImports{File: rel, Layer: layer, Imports: imports})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return files, nil
}
