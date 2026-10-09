"""Phase 5 finish line: the clinic buys from suppliers on purchase orders,
receives stock into lots with expiry dates, uses materials per procedure first
expiry first out, never goes below zero, moves stock between branches, gets
reorder suggestions, and can say which patients received an implant lot."""

import importlib
from datetime import timedelta
from decimal import Decimal

from django.apps import apps
from django.utils import timezone

from erp.core.models import AuditEntry, Role
from erp.lab.tests.test_phase4 import Phase4Base
from erp.masterdata.models import Branch, Procedure

from ..models import ProcedureMaterial, StockLot, StockMovement


class Phase5Base(Phase4Base):
    def setUp(self):
        super().setUp()
        c = self.clinic
        self.branch2 = Branch.objects.create(clinic=c, name_en="Maadi", name_ar="المعادي")
        self.make_user("accounts", "accountant")
        self.implant_proc = Procedure.objects.create(
            clinic=c, category=self.root_canal.category, code="IMP", name_en="Implant placement", name_ar="زرعة",
            default_duration_minutes=90,
        )
        self.today = timezone.localdate()
        self.login("owner")
        self.supplier = self.post("/api/inventory/suppliers/", {"name": "Dental Depot", "phone": "0100000000"})
        self.composite = self.post(
            "/api/inventory/items/",
            {"code": "CMP-A2", "name_en": "Composite A2", "name_ar": "كومبوزيت A2", "category": "material",
             "unit": "syringe", "reorder_level": "5", "reorder_quantity": "10", "last_cost": "300.00",
             "preferred_supplier": self.supplier["id"]},
        )
        self.implant = self.post(
            "/api/inventory/items/",
            {"code": "IMP-4010", "name_en": "Implant 4.0x10", "name_ar": "زرعة 4.0x10", "category": "implant",
             "brand": "Neo", "system": "IS-III", "diameter": "4.00", "length": "10.0", "last_cost": "3000.00",
             "preferred_supplier": self.supplier["id"]},
        )
        self.post("/api/inventory/procedure-materials/", {"procedure": self.root_canal.id, "item": self.composite["id"], "quantity": "1"})
        self.post("/api/inventory/procedure-materials/", {"procedure": self.implant_proc.id, "item": self.implant["id"], "quantity": "1"})

    def post(self, url, data, expect=201):
        response = self.client.post(url, data, format="json")
        self.assertEqual(response.status_code, expect, response.content)
        return response.data

    def ordered_po(self, lines, branch=None):
        po = self.post(
            "/api/inventory/purchase-orders/",
            {"supplier": self.supplier["id"], "branch": (branch or self.branch).id, "lines": lines},
        )
        return self.post(f"/api/inventory/purchase-orders/{po['id']}/order/", {}, expect=200)

    def receive(self, po, rows, expect=200):
        return self.post(f"/api/inventory/purchase-orders/{po['id']}/receive/", {"lines": rows}, expect=expect)

    def stock_in(self, item, quantity, lot_number="", expiry=None, cost="100.00", branch=None):
        po = self.ordered_po([{"item": item["id"], "quantity_ordered": quantity, "unit_cost": cost}], branch)
        row = {"line": po["lines"][0]["id"], "quantity": quantity, "lot_number": lot_number}
        if expiry:
            row["expiry_date"] = str(expiry)
        return self.receive(po, [row])

    def on_hand(self, item, branch=None):
        params = {"branch": branch.id} if branch else {}
        return Decimal(self.client.get(f"/api/inventory/items/{item['id']}/", params).data["on_hand"])

    def done_line(self, procedure, tooth=36):
        self.login("drsara")
        plan = self.plan()
        line = self.line(plan["id"], procedure=procedure.id, tooth=tooth)
        self.client.patch(f"/api/clinical/plan-lines/{line['id']}/", {"status": "done"}, format="json")
        return line


class PurchaseOrderTests(Phase5Base):
    def test_receiving_creates_lots_stock_and_last_cost(self):
        po = self.ordered_po(
            [{"item": self.composite["id"], "quantity_ordered": "10", "unit_cost": "280.00"},
             {"item": self.implant["id"], "quantity_ordered": "2", "unit_cost": "3100.00"}]
        )
        self.assertEqual(po["number"], "PO-00001")
        self.assertEqual(po["status"], "ordered")
        self.assertEqual(po["total"], "9000.00")
        comp_line, imp_line = po["lines"]
        # An implant needs its lot number; nobody receives more than was ordered.
        self.receive(po, [{"line": imp_line["id"], "quantity": "1"}], expect=400)
        self.receive(po, [{"line": comp_line["id"], "quantity": "11"}], expect=400)
        expiry = self.today + timedelta(days=400)
        po = self.receive(
            po,
            [{"line": comp_line["id"], "quantity": "10"},
             {"line": imp_line["id"], "quantity": "1", "lot_number": "LOT-A", "expiry_date": str(expiry)}],
        )
        self.assertEqual(po["status"], "partially_received")
        po = self.receive(po, [{"line": imp_line["id"], "quantity": "1", "lot_number": "LOT-B", "expiry_date": str(expiry)}])
        self.assertEqual(po["status"], "received")
        self.assertIsNotNone(po["received_at"])
        self.assertEqual(po["received_value"], "9000.00")

        self.assertEqual(self.on_hand(self.composite), 10)
        item = self.client.get(f"/api/inventory/items/{self.implant['id']}/").data
        self.assertEqual((item["on_hand"], item["last_cost"], item["stock_value"]), ("2.000", "3100.00", "6200.00"))
        self.assertEqual(item["next_expiry"], expiry)
        lots = self.client.get("/api/inventory/lots/", {"item": self.implant["id"]}).data["results"]
        self.assertEqual(sorted(x["lot_number"] for x in lots), ["LOT-A", "LOT-B"])
        self.assertEqual(lots[0]["purchase_order"], "PO-00001")
        moves = self.client.get("/api/inventory/movements/", {"purchase_order": po["id"], "kind": "receive"}).data
        self.assertEqual(moves["count"], 3)
        # Received stock is audited like every other clinic record.
        audited = AuditEntry.objects.filter(clinic=self.clinic, content_type__app_label="inventory")
        self.assertTrue(audited.filter(content_type__model="stockmovement", user__username="owner").exists())
        # Closed orders cannot be edited, received again or cancelled.
        self.assertEqual(self.client.patch(f"/api/inventory/purchase-orders/{po['id']}/", {"notes": "x"}, format="json").status_code, 400)
        self.post(f"/api/inventory/purchase-orders/{po['id']}/cancel/", {"reason": "x"}, expect=400)

    def test_draft_edit_and_cancel(self):
        po = self.post(
            "/api/inventory/purchase-orders/",
            {"supplier": self.supplier["id"], "branch": self.branch.id,
             "lines": [{"item": self.composite["id"], "quantity_ordered": "3"}]},
        )
        self.assertEqual(po["lines"][0]["unit_cost"], "300.00")  # last cost by default
        changed = self.client.patch(
            f"/api/inventory/purchase-orders/{po['id']}/",
            {"lines": [{"item": self.implant["id"], "quantity_ordered": "1", "unit_cost": "2900"}]}, format="json",
        )
        self.assertEqual([x["item"] for x in changed.data["lines"]], [self.implant["id"]])
        self.post(f"/api/inventory/purchase-orders/{po['id']}/receive/", {"lines": []}, expect=400)
        self.post(f"/api/inventory/purchase-orders/{po['id']}/cancel/", {}, expect=400)
        done = self.post(f"/api/inventory/purchase-orders/{po['id']}/cancel/", {"reason": "Better price elsewhere"}, expect=200)
        self.assertEqual(done["status"], "cancelled")

    def test_suggest_builds_drafts_from_reorder_levels(self):
        self.post("/api/inventory/items/", {"name_en": "Gloves M", "name_ar": "جوانتي", "category": "consumable",
                                            "unit": "box", "reorder_level": "2"})
        self.stock_in(self.composite, "3")
        result = self.post("/api/inventory/purchase-orders/suggest/", {"branch": self.branch.id})
        self.assertEqual(len(result["orders"]), 1)
        po = result["orders"][0]
        self.assertEqual((po["status"], po["supplier"]), ("draft", self.supplier["id"]))
        self.assertEqual([(x["item"], x["quantity_ordered"]) for x in po["lines"]], [(self.composite["id"], "10.000")])
        self.assertEqual([x["en"] for x in result["no_supplier"]], ["Gloves M"])
        # What is already on order counts as coming, so no second draft.
        again = self.post("/api/inventory/purchase-orders/suggest/", {"branch": self.branch.id}, expect=200)
        self.assertEqual(again["orders"], [])


class ConsumptionTests(Phase5Base):
    def test_fefo_from_a_plan_line_and_implant_trace(self):
        self.stock_in(self.implant, "1", "LOT-LATE", self.today + timedelta(days=300))
        self.stock_in(self.implant, "1", "LOT-EARLY", self.today + timedelta(days=60))
        # An expired lot is never picked.
        self.post("/api/inventory/adjust/", {"item": self.implant["id"], "branch": self.branch.id, "lot_number": "LOT-OLD",
                                             "expiry_date": str(self.today - timedelta(days=1)), "quantity": "1",
                                             "reason": "Opening stock"})
        line = self.done_line(self.implant_proc)
        planned = self.line(self.plan()["id"], procedure=self.implant_proc.id, tooth=46)

        self.login("assist")
        self.post("/api/inventory/consume/", {"plan_line": planned["id"], "branch": self.branch.id}, expect=400)
        used = self.post("/api/inventory/consume/", {"plan_line": line["id"], "branch": self.branch.id})
        self.assertEqual(len(used["movements"]), 1)
        move = used["movements"][0]
        self.assertEqual((move["lot_number"], move["quantity"], move["kind"]), ("LOT-EARLY", "-1.000", "use"))
        self.assertEqual(move["patient"], self.patient["id"])
        self.assertEqual(move["plan_line"], line["id"])
        self.assertEqual(used["total_value"], "100.00")
        # Recorded once per procedure unless asked again.
        self.post("/api/inventory/consume/", {"plan_line": line["id"], "branch": self.branch.id}, expect=400)

        trace = self.client.get("/api/inventory/implant-trace/", {"lot": "lot-early"}).data
        self.assertEqual(trace["patients"], 1)
        row = trace["results"][0]
        self.assertEqual(row["patient"]["id"], self.patient["id"])
        self.assertEqual((row["tooth"], row["item"]["system"], row["procedure"]["code"]), (36, "IS-III", "IMP"))
        by_patient = self.client.get("/api/inventory/implant-trace/", {"patient": self.patient["id"]}).data
        self.assertEqual([r["lot_number"] for r in by_patient["results"]], ["LOT-EARLY"])
        self.assertEqual(self.client.get("/api/inventory/implant-trace/", {"lot": "LOT-LATE"}).data["count"], 0)

        # The next one takes the later lot; then only expired stock is left.
        other = self.done_line(self.implant_proc, tooth=46)
        self.login("assist")
        self.assertEqual(self.post("/api/inventory/consume/", {"plan_line": other["id"], "branch": self.branch.id})["movements"][0]["lot_number"], "LOT-LATE")
        third = self.done_line(self.implant_proc, tooth=45)
        self.login("assist")
        self.post("/api/inventory/consume/", {"plan_line": third["id"], "branch": self.branch.id}, expect=400)

    def test_chosen_lot_and_override_lines(self):
        self.stock_in(self.implant, "1", "LOT-1", self.today + timedelta(days=30))
        self.stock_in(self.implant, "1", "LOT-2", self.today + timedelta(days=90))
        self.stock_in(self.composite, "5")
        lot2 = StockLot.objects.get(lot_number="LOT-2")
        line = self.done_line(self.implant_proc)
        self.login("assist")
        used = self.post("/api/inventory/consume/", {"plan_line": line["id"], "branch": self.branch.id,
                                                     "lots": {str(self.implant["id"]): lot2.id}})
        self.assertEqual(used["movements"][0]["lot_number"], "LOT-2")
        rct = self.done_line(self.root_canal, tooth=16)
        self.login("assist")
        used = self.post("/api/inventory/consume/", {"plan_line": rct["id"], "branch": self.branch.id,
                                                     "lines": [{"item": self.composite["id"], "quantity": "2"}]})
        self.assertEqual(used["movements"][0]["quantity"], "-2.000")
        self.assertEqual(self.on_hand(self.composite), 3)

    def test_stock_never_goes_negative(self):
        self.stock_in(self.composite, "2")
        line = self.done_line(self.root_canal)
        self.login("assist")
        self.post("/api/inventory/consume/", {"plan_line": line["id"], "branch": self.branch.id,
                                              "lines": [{"item": self.composite["id"], "quantity": "3"}]}, expect=400)
        self.assertEqual(self.on_hand(self.composite), 2)
        self.assertFalse(StockMovement.objects.filter(kind="use").exists())
        self.login("owner")
        self.post("/api/inventory/adjust/", {"item": self.composite["id"], "branch": self.branch.id, "kind": "waste",
                                             "quantity": "5", "reason": "Dropped"}, expect=400)
        self.post("/api/inventory/adjust/", {"item": self.composite["id"], "branch": self.branch.id, "quantity": "-3",
                                             "reason": "Count"}, expect=400)
        counted = self.post("/api/inventory/adjust/", {"item": self.composite["id"], "branch": self.branch.id,
                                                       "counted": "1", "reason": "Monthly count"})
        self.assertEqual((counted["kind"], counted["quantity"], counted["balance_after"]), ("adjust", "-1.000", "1.000"))
        wasted = self.post("/api/inventory/adjust/", {"item": self.composite["id"], "branch": self.branch.id,
                                                      "kind": "waste", "quantity": "1", "reason": "Expired"})
        self.assertEqual(wasted["quantity"], "-1.000")
        self.assertEqual(self.on_hand(self.composite), 0)

    def test_lab_technician_records_lab_material_use(self):
        wax = self.post("/api/inventory/items/", {"name_en": "Zirconia disc", "name_ar": "قرص زركونيا",
                                                  "category": "lab_material", "unit": "disc"})
        self.stock_in(wax, "2")
        self.login("drsara")
        case = self.order()
        self.login("tech")
        used = self.post("/api/inventory/consume/", {"lab_case": case["id"], "branch": self.branch.id,
                                                     "lines": [{"item": wax["id"], "quantity": "1"}]})
        self.assertEqual(used["movements"][0]["lab_case_number"], "LAB-00001")
        self.assertEqual(self.on_hand(wax), 1)


class ListAndTransferTests(Phase5Base):
    def test_low_stock_and_expiring_filters_and_summary(self):
        self.stock_in(self.composite, "4")
        self.stock_in(self.implant, "3", "LOT-X", self.today + timedelta(days=45), cost="3000.00")
        low = self.client.get("/api/inventory/items/", {"low": 1}).data["results"]
        self.assertEqual([x["id"] for x in low], [self.composite["id"]])
        self.assertTrue(low[0]["is_low"])
        soon = self.client.get("/api/inventory/items/", {"expiring": 60}).data["results"]
        self.assertEqual([x["id"] for x in soon], [self.implant["id"]])
        self.assertEqual(self.client.get("/api/inventory/items/", {"expiring": 30}).data["count"], 0)
        self.assertEqual(self.client.get("/api/inventory/items/", {"search": "4.0x10"}).data["count"], 1)
        self.assertEqual(self.client.get("/api/inventory/items/", {"category": "implant"}).data["count"], 1)
        self.assertEqual(self.client.get("/api/inventory/items/", {"low": 1, "branch": self.branch2.id}).data["count"], 1)
        lots = self.client.get("/api/inventory/lots/", {"expiring": 60}).data["results"]
        self.assertEqual((lots[0]["lot_number"], lots[0]["days_to_expiry"]), ("LOT-X", 45))
        summary = self.client.get("/api/inventory/summary/").data
        self.assertEqual((summary["items"], summary["low_stock"]), (2, 1))
        self.assertEqual((summary["expiring_30"], summary["expiring_60"], summary["expiring_90"]), (0, 1, 1))
        self.assertEqual(summary["stock_value"], "9400.00")

    def test_transfer_between_branches_keeps_lots(self):
        self.stock_in(self.composite, "10")
        self.stock_in(self.implant, "2", "LOT-T", self.today + timedelta(days=200), cost="3000.00")
        moves = self.post("/api/inventory/transfer/", {"item": self.composite["id"], "from_branch": self.branch.id,
                                                       "to_branch": self.branch2.id, "quantity": "4"})
        self.assertEqual([m["kind"] for m in moves], ["transfer_out", "transfer_in"])
        self.assertEqual(self.on_hand(self.composite, self.branch), 6)
        self.assertEqual(self.on_hand(self.composite, self.branch2), 4)
        self.post("/api/inventory/transfer/", {"item": self.composite["id"], "from_branch": self.branch.id,
                                               "to_branch": self.branch2.id, "quantity": "7"}, expect=400)
        self.post("/api/inventory/transfer/", {"item": self.implant["id"], "from_branch": self.branch.id,
                                               "to_branch": self.branch2.id, "quantity": "1"})
        moved = StockLot.objects.get(branch=self.branch2, item_id=self.implant["id"])
        self.assertEqual((moved.lot_number, moved.quantity, moved.unit_cost), ("LOT-T", 1, Decimal("3000.00")))
        self.assertEqual(moved.expiry_date, self.today + timedelta(days=200))

    def test_usage_report(self):
        self.stock_in(self.composite, "10", cost="300.00")
        line = self.done_line(self.root_canal)
        self.login("owner")
        self.post("/api/inventory/consume/", {"plan_line": line["id"], "branch": self.branch.id})
        report = self.client.get("/api/inventory/report/").data
        self.assertEqual(report["consumed_value"], "300.00")
        self.assertEqual(report["consumption_by_item"][0]["quantity"], "1.000")
        self.assertEqual(report["consumption_by_category"][0]["category"], "material")
        self.assertEqual(report["consumption_by_procedure"][0]["code"], "RCT")
        self.assertEqual(report["stock_by_category"][0]["value"], "2700.00")
        self.assertEqual(report["purchases_by_supplier"][0]["value"], "3000.00")


class PermissionTests(Phase5Base):
    def test_role_rights(self):
        po = self.post("/api/inventory/purchase-orders/", {"supplier": self.supplier["id"], "branch": self.branch.id,
                                                           "lines": [{"item": self.composite["id"], "quantity_ordered": "1"}]})
        self.login("reception")
        self.assertEqual(self.client.get("/api/inventory/items/").status_code, 200)
        self.assertEqual(self.client.post("/api/inventory/items/", {"name_en": "X", "name_ar": "س"}, format="json").status_code, 403)
        self.assertEqual(self.client.post("/api/inventory/consume/", {"branch": self.branch.id}, format="json").status_code, 403)
        self.assertEqual(self.client.post(f"/api/inventory/purchase-orders/{po['id']}/order/").status_code, 403)

        self.login("assist")
        self.assertEqual(self.client.post("/api/inventory/items/", {"name_en": "X", "name_ar": "س"}, format="json").status_code, 403)
        self.assertEqual(self.client.post(f"/api/inventory/purchase-orders/{po['id']}/order/").status_code, 403)
        self.assertEqual(self.client.get("/api/inventory/report/").status_code, 403)

        self.login("accounts")
        self.assertEqual(self.client.post("/api/inventory/purchase-orders/", {"supplier": self.supplier["id"], "branch": self.branch.id}, format="json").status_code, 403)
        ordered = self.client.post(f"/api/inventory/purchase-orders/{po['id']}/order/")
        self.assertEqual((ordered.status_code, ordered.data["status"]), (200, "ordered"))
        self.assertEqual(self.client.get("/api/inventory/report/").status_code, 200)

        self.login("drsara")
        self.assertEqual(self.client.get("/api/inventory/summary/").status_code, 200)
        self.assertEqual(self.client.post("/api/inventory/adjust/", {}, format="json").status_code, 403)

    def test_existing_clinics_get_the_new_rights(self):
        role = Role.objects.get(clinic=self.clinic, code="assistant")
        role.permissions = {**role.permissions, "inventory": ["view", "edit"]}
        role.save()
        custom = Role.objects.get(clinic=self.clinic, code="lab_technician")
        custom.permissions = {**custom.permissions, "inventory": ["view", "delete"]}
        custom.save()
        migration = importlib.import_module("erp.inventory.migrations.0002_role_permissions")
        migration.forwards(apps, None)
        role.refresh_from_db()
        custom.refresh_from_db()
        self.assertEqual(role.permissions["inventory"], ["view", "create"])
        self.assertEqual(custom.permissions["inventory"], ["view", "delete"])  # hand-set rights are kept

    def test_materials_and_lots_stay_inside_the_clinic(self):
        self.assertEqual(ProcedureMaterial.objects.filter(clinic=self.clinic).count(), 2)
        self.login("other")
        self.assertEqual(self.client.get("/api/inventory/items/").data["count"], 0)
        bad = self.client.post("/api/inventory/procedure-materials/", {"procedure": self.root_canal.id,
                                                                        "item": self.composite["id"]}, format="json")
        self.assertEqual(bad.status_code, 400)
