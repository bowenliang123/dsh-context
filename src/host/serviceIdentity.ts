import { asRecord } from './record'

export function serviceIdentityOf(service: unknown): unknown {
  return asRecord(service)?.identity ?? service
}
