package cli

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// ParsedArgs is what Parse returns: the option values and the positionals.
type ParsedArgs struct {
	Values      map[string]any
	Positionals []string
}

// Parse takes strict flags (unknown ones are an error) and any number of positionals. The error is
// the first sentence of node:util parseArgs' own message, byte for byte: the CLI prints it after
// the provider's name.
func Parse(argv []string, options map[string]OptionSpec) (ParsedArgs, error) {
	values := map[string]any{}
	positionals := make([]string, 0, len(argv))
	for i := 0; i < len(argv); i++ {
		token := argv[i]
		switch {
		case token == "--":
			return ParsedArgs{Values: values, Positionals: append(positionals, argv[i+1:]...)}, nil
		case strings.HasPrefix(token, "--"):
			name := token[2:]
			value := ""
			inline := false
			// node splits on the first '=' only past the name's first character, so `--=x` is the
			// unknown option `--=x`, not an empty name with a value.
			if at := strings.IndexByte(name, '='); at > 0 {
				value = name[at+1:]
				name = name[:at]
				inline = true
			}
			spec, known := options[name]
			if !known {
				return ParsedArgs{}, errors.New("Unknown option '--" + name + "'")
			}
			if spec.Type == OptionTypeBoolean {
				if inline {
					return ParsedArgs{}, errors.New("Option '--" + name + "' does not take an argument")
				}
				values[name] = true
				continue
			}
			if !inline {
				if i+1 >= len(argv) {
					return ParsedArgs{}, errors.New("Option '--" + name + " <value>' argument missing")
				}
				next := argv[i+1]
				if next != "-" && strings.HasPrefix(next, "-") {
					return ParsedArgs{}, errors.New("Option '--" + name + "' argument is ambiguous.\n" +
						"Did you forget to specify the option argument for '--" + name + "'?\n" +
						"To specify an option argument starting with a dash use '--" + name + "=-XYZ'.")
				}
				value = next
				i++
			}
			values[name] = value
		case len(token) > 1 && token[0] == '-':
			// No command defines short options, so every short token is unknown; node names it by
			// its first character.
			first := token[1:]
			if _, size := utf8.DecodeRuneInString(first); size > 0 {
				first = first[:size]
			}
			return ParsedArgs{}, errors.New("Unknown option '-" + first + "'")
		default:
			positionals = append(positionals, token)
		}
	}
	return ParsedArgs{Values: values, Positionals: positionals}, nil
}
