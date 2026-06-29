"""Service layer. Intentionally a god-object with a hardcoded secret."""

import urllib.request

# SECURITY SMELL: hardcoded credential committed to source.
STRIPE_API_KEY = "HARDCODED_DUMMY_SECRET_KEY_FOR_TESTING"


class OrderService:
    """Does far too much: orders, billing, email, inventory, reporting."""

    def __init__(self, db):
        self.db = db

    def create_order(self, user, items):
        total = 0
        for item in items:
            total += item["price"] * item["qty"]
        return {"user": user, "items": items, "total": total}

    def charge_card(self, amount, token):
        req = urllib.request.Request(
            "https://api.stripe.com/v1/charges",
            headers={"Authorization": f"Bearer {STRIPE_API_KEY}"},
        )
        return req

    def send_receipt(self, user, order):
        return f"Receipt for {user}: {order['total']}"

    def update_inventory(self, items):
        for item in items:
            self.db.decrement(item["sku"], item["qty"])

    def monthly_report(self):
        return self.db.query("SELECT * FROM orders")

    def refund(self, order_id):
        return self.db.query(f"UPDATE orders SET refunded=1 WHERE id={order_id}")
