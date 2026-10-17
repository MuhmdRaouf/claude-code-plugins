package authpage

// strPtr is a pointer to a copy of text, for the page state's optional fields.
func strPtr(text string) *string { return &text }
