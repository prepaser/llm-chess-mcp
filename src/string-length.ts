export function unicodeLength(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}
