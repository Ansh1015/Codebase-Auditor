import { OrderService } from "./services";
import { computeDiscount, normalizeEmail } from "./utils";

export function run(
  db: { query(sql: string): unknown },
  email: string,
  items: { price: number; qty: number }[],
) {
  const e = normalizeEmail(email);
  const svc = new OrderService(db);
  const order = svc.createOrder(e, items);
  return { ...order, total: computeDiscount(order.total, "gold") };
}
