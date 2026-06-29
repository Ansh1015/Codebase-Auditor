import { request } from "node:https";

// SECURITY: hardcoded credential in source
const STRIPE_API_KEY = "HARDCODED_DUMMY_SECRET_KEY_FOR_TESTING";

export class OrderService {
  constructor(private db: { query(sql: string): unknown }) {}

  createOrder(user: string, items: { price: number; qty: number }[]) {
    let total = 0;
    for (const it of items) total += it.price * it.qty;
    return { user, items, total };
  }

  chargeCard(amount: number, token: string) {
    return request("https://api.stripe.com/v1/charges", {
      headers: { Authorization: `Bearer ${STRIPE_API_KEY}` },
    });
  }

  refund(orderId: string) {
    return this.db.query(`UPDATE orders SET refunded=1 WHERE id=${orderId}`);
  }
}
