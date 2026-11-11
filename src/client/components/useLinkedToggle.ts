import { useState } from 'react'

export function useLinkedToggle(
  linked: boolean | undefined,
  onChange: ((on: boolean) => void) | undefined,
): [boolean, (on: boolean) => void] {
  const [local, setLocal] = useState(false)
  const controlled = linked !== undefined && onChange !== undefined
  const accept = controlled ? onChange : undefined
  return [
    controlled && linked ? true : local,
    (on) => {
      if (accept !== undefined) accept(on)
      else setLocal(on)
    },
  ]
}
