/** KYC masking: the last 4 characters only. Values of 4 characters or fewer are fully hidden. */
export function maskLast4(value: string): string {
  const visible = value.length > 4 ? value.slice(-4) : '';
  return '•'.repeat(Math.max(value.length - visible.length, 4)) + visible;
}
