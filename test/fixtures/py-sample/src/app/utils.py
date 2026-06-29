"""Small utility helpers."""


def normalize_email(email):
    # Duplicated business logic — mirrored verbatim in helpers.py
    return email.strip().lower()


def compute_discount(price, customer_tier):
    # Duplicated business logic — mirrored verbatim in helpers.py
    if customer_tier == "gold":
        return price * 0.8
    if customer_tier == "silver":
        return price * 0.9
    return price
