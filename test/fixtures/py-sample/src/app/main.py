"""Entry point. Wires the app together."""

from app.utils import normalize_email, compute_discount
from app.services import OrderService


def run(db, user_email, items):
    email = normalize_email(user_email)
    service = OrderService(db)
    order = service.create_order(email, items)
    order["total"] = compute_discount(order["total"], "gold")
    return order
