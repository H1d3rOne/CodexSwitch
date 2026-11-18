import { describe, expect, it } from 'vitest'
import { decodeBase64ApiKey } from '../../src/utils/apiKey'

describe('decodeBase64ApiKey', () => {
  it('decodes padded and unpadded Base64 keys', () => {
    const key = 'sk-example-secret'
    expect(decodeBase64ApiKey(btoa(key))).toBe(key)
    expect(decodeBase64ApiKey(btoa(key).replace(/=+$/, ''))).toBe(key)
    expect(decodeBase64ApiKey(` ${btoa(key)}\n`)).toBe(key)
  })

  it.each(['', 'sk-normal-secret', 'abcd1234', 'abcde', 'YWJj===', 'YR==', 'YW Jj', btoa('key\nvalue'), btoa('\x00\xff')])('preserves invalid or non-token input %j', value => {
    expect(decodeBase64ApiKey(value)).toBe(value)
  })
})
