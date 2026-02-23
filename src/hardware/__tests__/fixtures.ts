/**
 * Test fixtures for hardware responses.
 * These represent realistic data from the actual pod hardware daemon.
 */

/**
 * Standard device status response from Pod 4 hardware.
 * Format: key = value pairs, terminated by double newline.
 */
export const DEVICE_STATUS_POD4 = `tgHeatLevelR = 50
tgHeatLevelL = -30
heatTimeL = 1800
heatLevelL = -25
heatTimeR = 3600
heatLevelR = 45
sensorLabel = 8SLEEP-SN-12345-I00
waterLevel = true
priming = false
doubleTap = {"l":0,"r":1}
tripleTap = {"l":2,"r":0}
quadTap = {"l":0,"r":0}

`

/**
 * Device status from Pod 3 hardware (no gesture support).
 */
export const DEVICE_STATUS_POD3 = `tgHeatLevelR = 0
tgHeatLevelL = 0
heatTimeL = 0
heatLevelL = 0
heatTimeR = 0
heatLevelR = 0
sensorLabel = 8SLEEP-SN-98765-H00
waterLevel = true
priming = false

`

/**
 * Device status from Pod 5 hardware.
 */
export const DEVICE_STATUS_POD5 = `tgHeatLevelR = 100
tgHeatLevelL = -100
heatTimeL = 600
heatLevelL = -95
heatTimeR = 900
heatLevelR = 98
sensorLabel = 8SLEEP-SN-54321-J00
waterLevel = false
priming = true
doubleTap = {"l":1,"r":1}
tripleTap = {"l":0,"r":0}
quadTap = {"l":3,"r":2}

`

/**
 * Simple OK response for successful commands.
 */
export const OK_RESPONSE = 'OK\n\n'

/**
 * Empty response (also indicates success).
 */
export const EMPTY_RESPONSE = '\n\n'

/**
 * Error response from hardware.
 */
export const ERROR_RESPONSE = 'ERROR: Invalid parameter\n\n'

/**
 * HELLO command response (firmware handshake).
 */
export const HELLO_RESPONSE = 'READY\n\n'

/**
 * CBOR-encoded settings data (hex string).
 * This represents actual firmware settings format.
 */
export const CBOR_SETTINGS_HEX = 'a3667465737431016674657374320263746573743303'

/**
 * Expected parsed structure of CBOR settings above.
 */
export const CBOR_SETTINGS_PARSED = {
  test1: 1,
  test2: 2,
  test3: 3,
}

/**
 * Hardware command protocol constants.
 */
export const PROTOCOL = {
  DELIMITER: '\n\n',
  COMMAND_FORMAT: (code: string, arg: string) => `${code}\n${arg}\n\n`,
}

/**
 * Timing constants for realistic hardware simulation.
 */
export const TIMING = {
  COMMAND_PROCESSING_MS: 10, // Hardware processing delay
  CONNECTION_TIMEOUT_MS: 100, // Quick timeout for tests
  READ_TIMEOUT_MS: 50, // Message read timeout
}
