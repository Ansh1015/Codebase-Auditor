from app.main import run


class FakeDB:
    def decrement(self, sku, qty):
        pass

    def query(self, q):
        return []


def test_run_applies_discount():
    out = run(FakeDB(), " USER@EXAMPLE.COM ", [{"price": 100, "qty": 1}])
    assert out["total"] == 80
