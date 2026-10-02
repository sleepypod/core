import type { DemoHandlers, RouterOutputs } from '../types'

type Status = RouterOutputs['homekit']['getStatus']

let enabled = true
let paired = ['Home (iPhone)']

function status(): Status {
  return {
    enabled,
    running: enabled,
    transitioning: false,
    pincode: enabled && paired.length === 0 ? '031-45-154' : null,
    setupId: enabled ? 'DEMO' : null,
    setupURI: null,
    qrDataUrl: null,
    pairedControllers: enabled ? paired : [],
  }
}

export const homekit: DemoHandlers<'homekit'> = {
  getStatus: status,

  setEnabled: (input) => {
    enabled = input.enabled
    return status()
  },

  unpair: () => {
    paired = []
    return status()
  },

  regenerate: () => status(),
}
