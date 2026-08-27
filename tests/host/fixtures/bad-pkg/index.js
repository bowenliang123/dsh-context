// Throwaway fixture with a malformed package.json: exercises the fallback
// walk that keeps ascending to a readable package boundary.

export function broken() {
  return 'broken'
}