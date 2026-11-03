"""
Tests for restocking API endpoints.
"""
import pytest

import mock_data


@pytest.fixture(autouse=True)
def clear_restock_orders():
    """Reset in-memory restock orders so tests stay independent.

    main.py imports the same list object from mock_data, so clear() in place
    (rebinding the name would leave main.py pointing at the old list).
    """
    mock_data.restock_orders.clear()
    yield
    mock_data.restock_orders.clear()


TREND_RANK = {"increasing": 0, "stable": 1, "decreasing": 2}


class TestRestockRecommendations:
    """Test suite for GET /api/restocking/recommendations."""

    def test_get_recommendations_structure(self, client):
        """Test recommendations return the expected fields and types."""
        response = client.get("/api/restocking/recommendations?budget=10000")
        assert response.status_code == 200

        data = response.json()
        assert isinstance(data, list)
        assert len(data) > 0
        for item in data:
            for field in ["sku", "name", "quantity", "unit_cost", "lead_time_days",
                          "trend", "demand_gap", "line_total"]:
                assert field in item
            assert isinstance(item["quantity"], int)
            assert item["quantity"] > 0
            assert item["quantity"] <= item["demand_gap"]
            assert abs(item["line_total"] - item["quantity"] * item["unit_cost"]) < 0.01

    @pytest.mark.parametrize("budget", [100, 1000, 5000, 25000, 50000])
    def test_recommendations_within_budget(self, client, budget):
        """Test the recommended total never exceeds the budget."""
        data = client.get(f"/api/restocking/recommendations?budget={budget}").json()
        assert sum(item["line_total"] for item in data) <= budget + 0.01

    def test_recommendations_zero_budget(self, client):
        """Test a zero budget yields no recommendations."""
        response = client.get("/api/restocking/recommendations?budget=0")
        assert response.status_code == 200
        assert response.json() == []

    def test_recommendations_negative_budget(self, client):
        """Test a negative budget is rejected."""
        response = client.get("/api/restocking/recommendations?budget=-5")
        assert response.status_code == 400

    def test_recommendations_trend_priority(self, client):
        """Test increasing-trend items are ranked before stable/decreasing."""
        data = client.get("/api/restocking/recommendations?budget=50000").json()
        ranks = [TREND_RANK[item["trend"]] for item in data]
        assert ranks == sorted(ranks)

    def test_recommendations_exclude_non_positive_gap(self, client):
        """Test items with falling demand (gap <= 0) are never recommended."""
        forecasts = client.get("/api/demand").json()
        no_gap = {f["item_sku"] for f in forecasts
                  if f["forecasted_demand"] - f["current_demand"] <= 0}
        data = client.get("/api/restocking/recommendations?budget=50000").json()
        assert not no_gap & {item["sku"] for item in data}


class TestRestockOrders:
    """Test suite for /api/restocking/orders."""

    def _payload(self, client, budget=10000):
        recs = client.get(f"/api/restocking/recommendations?budget={budget}").json()
        items = [{k: r[k] for k in ["sku", "name", "quantity", "unit_cost", "lead_time_days"]}
                 for r in recs]
        return {"budget": budget, "items": items}

    def test_get_restock_orders_empty(self, client):
        """Test listing orders when none have been submitted."""
        response = client.get("/api/restocking/orders")
        assert response.status_code == 200
        assert response.json() == []

    def test_create_restock_order(self, client):
        """Test submitting a valid restock order."""
        payload = self._payload(client)
        response = client.post("/api/restocking/orders", json=payload)
        assert response.status_code == 201

        order = response.json()
        assert order["status"] == "Submitted"
        assert order["order_number"].startswith("RST-")
        expected_total = sum(i["quantity"] * i["unit_cost"] for i in payload["items"])
        assert abs(order["total_cost"] - expected_total) < 0.01
        assert order["lead_time_days"] == max(i["lead_time_days"] for i in payload["items"])
        assert "T" in order["submitted_date"]
        assert order["expected_delivery"] > order["submitted_date"]

    def test_create_restock_order_uses_server_prices(self, client):
        """Test client-supplied unit costs are ignored in favor of server data."""
        payload = self._payload(client)
        real = client.post("/api/restocking/orders", json=payload).json()["total_cost"]
        for item in payload["items"]:
            item["unit_cost"] = 0.01
        tampered = client.post("/api/restocking/orders", json=payload).json()
        assert abs(tampered["total_cost"] - real) < 0.01

    def test_create_restock_order_over_budget(self, client):
        """Test an order exceeding its budget is rejected."""
        payload = self._payload(client, budget=10000)
        payload["budget"] = 1
        response = client.post("/api/restocking/orders", json=payload)
        assert response.status_code == 400
        assert "exceeds budget" in response.json()["detail"]

    def test_create_restock_order_unknown_sku(self, client):
        """Test an unknown SKU is rejected."""
        payload = {"budget": 1000, "items": [{"sku": "NOPE-999", "name": "x", "quantity": 1,
                                              "unit_cost": 1, "lead_time_days": 1}]}
        response = client.post("/api/restocking/orders", json=payload)
        assert response.status_code == 400
        assert "unknown sku" in response.json()["detail"].lower()

    @pytest.mark.parametrize("payload", [
        {"budget": 1000, "items": []},
        {"budget": 0, "items": [{"sku": "WDG-001", "name": "x", "quantity": 1,
                                 "unit_cost": 1, "lead_time_days": 1}]},
        {"budget": 1000, "items": [{"sku": "WDG-001", "name": "x", "quantity": 0,
                                    "unit_cost": 1, "lead_time_days": 1}]},
    ])
    def test_create_restock_order_validation(self, client, payload):
        """Test empty items, zero budget and zero quantity fail validation."""
        response = client.post("/api/restocking/orders", json=payload)
        assert response.status_code == 422

    def test_submitted_order_listed_newest_first(self, client):
        """Test submitted orders appear in the list, newest first."""
        first = client.post("/api/restocking/orders", json=self._payload(client)).json()
        second = client.post("/api/restocking/orders", json=self._payload(client)).json()
        data = client.get("/api/restocking/orders").json()
        assert [o["order_number"] for o in data] == [second["order_number"], first["order_number"]]
