package omprpc

// ptr is a pointer to a copy of value, for the optional fields of the RPC frames.
func ptr[T any](value T) *T { return &value }
