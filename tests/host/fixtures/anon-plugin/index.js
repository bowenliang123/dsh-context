// Throwaway fixture emulating an anonymous locally linked plugin: its
// entrypoint carries no name (so cordis falls back to the root fiber name),
// and it registers a tool straight from its own package directory.

export function registerBlind(tools) {
  return tools.register({ name: 'blind_tool' })
}