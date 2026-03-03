/** Encode state for OAuth callback: credentialId|successRedirect */
export function encodeState(credentialId: string, successRedirect: string): string {
  return `${credentialId}|${successRedirect}`;
}

export function decodeState(state: string): { credentialId: string; successRedirect: string } {
  const idx = state.indexOf('|');
  if (idx < 0) return { credentialId: state, successRedirect: '' };
  return {
    credentialId: state.slice(0, idx),
    successRedirect: state.slice(idx + 1),
  };
}
