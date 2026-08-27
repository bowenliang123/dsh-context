// Throwaway fixture emulating a locally linked third-party plugin: it registers
// tools against a tools service instance handed to it (like a real plugin
// calling `ctx.tools.register(...)` from inside its own package directory).

export function registerTool(tools) {
  tools.register({ name: 'local_tool', description: 'from a local link' })
}