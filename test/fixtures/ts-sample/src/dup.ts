// Duplicated business logic — copy of utils.ts
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function computeDiscount(price: number, tier: string): number {
  if (tier === "gold") return price * 0.8;
  if (tier === "silver") return price * 0.9;
  return price;
}
