"""Phase 3 finish line: reception invoices done treatment plan lines, takes
payments by method (also in installments), closes the cashbox at the end of
the day, and the owner sees what each dentist's commission rule earns."""

from datetime import timedelta

from django.utils import timezone

from erp.clinical.tests.test_phase2 import Phase2Base


class Phase3Base(Phase2Base):
    def setUp(self):
        super().setUp()
        self.dentist.commission_type = "percent_collected"
        self.dentist.commission_value = 30
        self.dentist.save()
        plan = self.plan()
        self.rct = self.line(plan["id"], price="3000.00", discount="200.00", status="done")
        self.crown = self.line(plan["id"], tooth=26, price="6000.00")
        self.today = timezone.localdate()
        self.login("reception")

    def invoice(self, expect=201, **extra):
        data = {"patient": self.patient["id"], "plan_lines": [self.rct["id"]], **extra}
        response = self.client.post("/api/billing/invoices/", data, format="json")
        self.assertEqual(response.status_code, expect, response.content)
        return response.data

    def pay(self, invoice, amount, method="cash", expect=201, **extra):
        data = {"patient": self.patient["id"], "invoice": invoice["id"], "amount": amount, "method": method, **extra}
        response = self.client.post("/api/billing/payments/", data, format="json")
        self.assertEqual(response.status_code, expect, response.content)
        return response.data


class InvoiceTests(Phase3Base):
    def test_invoice_from_plan_lines_and_extras(self):
        billable = self.client.get("/api/billing/invoices/billable/", {"patient": self.patient["id"]}).data
        self.assertEqual({b["id"] for b in billable}, {self.rct["id"], self.crown["id"]})
        inv = self.invoice(extra_lines=[{"description": "Panoramic X-ray", "unit_price": "300.00"}], discount="100.00")
        self.assertEqual(inv["number"], "INV-00001")
        self.assertEqual(inv["totals"]["subtotal"], "3100.00")
        self.assertEqual(inv["totals"]["total"], "3000.00")
        self.assertEqual(inv["payment_status"], "unpaid")
        self.assertEqual(inv["lines"][0]["dentist"], self.dentist.id)
        # The same procedure cannot be billed twice.
        self.invoice(expect=400)
        billable = self.client.get("/api/billing/invoices/billable/", {"patient": self.patient["id"]}).data
        self.assertEqual([b["id"] for b in billable], [self.crown["id"]])

    def test_payments_track_balance_and_cannot_overpay(self):
        inv = self.invoice()
        first = self.pay(inv, "1000.00", method="instapay", reference="IP-123")
        self.assertEqual(first["receipt_number"], "RC-00001")
        self.pay(inv, "5000.00", expect=400)
        self.pay(inv, "1800.00")
        inv = self.client.get(f"/api/billing/invoices/{inv['id']}/").data
        self.assertEqual(inv["payment_status"], "paid")
        account = self.client.get(f"/api/billing/patients/{self.patient['id']}/account/").data
        self.assertEqual(account, {"billed": "2800.00", "paid": "2800.00", "balance": "0.00", "on_account": "0.00"})

    def test_installments_split_the_balance(self):
        inv = self.invoice(plan_lines=[self.crown["id"]])
        self.pay(inv, "1000.00")
        response = self.client.post(
            f"/api/billing/invoices/{inv['id']}/installments/", {"count": 3, "first_due": str(self.today)}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.content)
        amounts = [i["amount"] for i in response.data["installments"]]
        self.assertEqual(amounts, ["1666.00", "1666.00", "1668.00"])
        first = response.data["installments"][0]
        self.pay(inv, "2000.00", installment=first["id"], expect=400)
        self.pay(inv, "1666.00", installment=first["id"])
        due = self.client.get("/api/billing/installments/", {"until": str(self.today + timedelta(days=40))}).data
        self.assertEqual([d["number"] for d in due], [2])

    def test_void_rules(self):
        inv = self.invoice()
        payment = self.pay(inv, "500.00")
        self.assertEqual(self.client.post(f"/api/billing/payments/{payment['id']}/void/", {"reason": "x"}).status_code, 403)
        self.login("owner")
        self.assertEqual(self.client.post(f"/api/billing/invoices/{inv['id']}/void/", {"reason": "wrong"}).status_code, 400)
        self.assertEqual(self.client.post(f"/api/billing/payments/{payment['id']}/void/", {"reason": "Typed twice"}).status_code, 200)
        self.assertEqual(self.client.post(f"/api/billing/invoices/{inv['id']}/void/", {"reason": "wrong"}).status_code, 200)
        # A void invoice frees its procedures for a new invoice.
        self.login("reception")
        self.invoice()


class CashboxAndCommissionTests(Phase3Base):
    def test_closing_the_day_locks_its_payments(self):
        inv = self.invoice()
        self.pay(inv, "1000.00", method="cash")
        self.pay(inv, "500.00", method="card")
        box = self.client.get("/api/billing/cashbox/").data
        self.assertEqual(box["totals"], {"cash": "1000.00", "card": "500.00"})
        self.assertEqual(box["expected_cash"], "1000.00")
        closed = self.client.post("/api/billing/cashbox/", {"counted_cash": "990"}, format="json")
        self.assertTrue(closed.data["closed_by"])
        self.assertEqual(closed.status_code, 201, closed.content)
        self.assertEqual(closed.data["difference"], "-10.00")
        self.assertEqual(self.client.post("/api/billing/cashbox/", {"counted_cash": "990"}, format="json").status_code, 400)
        self.pay(inv, "100.00", expect=400)
        self.pay(inv, "100.00", paid_on=str(self.today + timedelta(days=1)))

    def test_commission_on_collected(self):
        inv = self.invoice(extra_lines=[{"description": "Whitening", "unit_price": "2800.00", "dentist": self.dentist2.id}])
        self.pay(inv, "2800.00")
        self.login("owner")
        rows = {r["dentist"]: r for r in self.client.get("/api/billing/commissions/").data["rows"]}
        mine = rows[self.dentist.id]
        self.assertEqual(mine["billed"], "2800.00")
        self.assertEqual(mine["collected"], "1400.00")
        self.assertEqual(mine["commission"], "420.00")
        self.assertEqual(rows[self.dentist2.id]["commission"], "0.00")

    def test_roles(self):
        self.login("drsara")
        self.assertEqual(self.client.get("/api/billing/invoices/").status_code, 403)
        self.login("other")
        self.assertEqual(self.client.get("/api/billing/invoices/").data["results"], [])


class DailyTakingsTests(Phase3Base):
    def test_week_of_takings(self):
        inv = self.invoice()
        self.pay(inv, "1000.00")
        self.pay(inv, "500.00", method="card")
        days = self.client.get("/api/billing/daily/").data
        self.assertEqual(len(days), 7)
        self.assertEqual(days[-1]["date"], self.today)
        self.assertEqual(days[-1]["total"], "1500.00")
        self.assertEqual(days[0]["total"], "0.00")
        self.login("drsara")
        self.assertEqual(self.client.get("/api/billing/daily/").status_code, 403)
