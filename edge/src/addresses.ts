/**
 * The key a caller is limited by: an IPv4 address as is, an IPv6 address by
 * its /64, the block one subscriber is given whole, so stepping through
 * addresses in it never earns a fresh limit.
 */
export function callerKey(address?: string) {
  if (!address) return "unknown";
  if (!address.includes(":")) return address;
  const [head, tail] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"),
          ...right,
        ];
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
