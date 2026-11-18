/** Decode a single Base64 layer only when it contains a printable API token. */
export function decodeBase64ApiKey(value: string): string {
  const encoded = value.trim()
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return value
  const unpadded = encoded.replace(/=+$/, '')
  if (unpadded.length % 4 === 1 || (encoded.includes('=') && encoded.length % 4 !== 0)) return value
  try {
    const decoded = atob(encoded)
    // Reject binary, whitespace, and noncanonical encodings to avoid damaging ordinary keys.
    if (!/^[\x21-\x7e]+$/.test(decoded) || btoa(decoded).replace(/=+$/, '') !== unpadded) return value
    return decoded
  } catch {
    return value
  }
}
