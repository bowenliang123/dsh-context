export const WIRE_BYTES = {
  base: 4_096,
  request: 512,
  event: 240,
  node: 200,
  fileOp: 280,
  command: 640,
  span: 96,
  system: 240,
  entry: 128,
} as const

export function textBytes(value: string | undefined): number {
  return value === undefined ? 0 : value.length * 2
}
