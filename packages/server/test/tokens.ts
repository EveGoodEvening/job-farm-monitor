// Test-only credentials shared by the node suites and the workerd config.
export const READ_TOKEN = 'read-token-0123456789abcdef';
export const WRITE_TOKEN_A = 'write-token-host-a-0123456789';
export const WRITE_TOKEN_B = 'write-token-host-b-0123456789';
export const WRITE_TOKENS = `hostA:${WRITE_TOKEN_A}, hostB:${WRITE_TOKEN_B}`;
