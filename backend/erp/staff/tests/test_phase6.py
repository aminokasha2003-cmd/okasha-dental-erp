"""Phase 6 finish line: the clinic rosters shifts, staff clock in and out
(lateness and overtime worked out against the roster), ask for leave, take
salary advances, and the owner runs a monthly payroll that pays salary,
overtime and the billing commission, deducts lateness, absence, unpaid leave,
advance installments and social insurance, and prints payslips. Each person
sees only their own pay unless their role allows more."""

import importlib
from datetime import time, timedelta
from decimal import Decimal

from django.apps import apps
from django.utils import timezone

from erp.billing.tests.test_phase3 import Phase3Base
from erp.core.models import AuditEntry, Role
from erp.core.tests.test_phase0 import PASSWORD
from erp.masterdata.models import StaffMember

from ..models import AttendanceRecord, RosterEntry, SalaryAdvance
from ..services import add_months


class Phase6Base(Phase3Base):
    def setUp(self):
        super().setUp()
        c = self.clinic
        self.make_user("accounts", "accountant")
        self.today = timezone.localdate()
        self.month = add_months(self.today.replace(day=1), -1)  # last month: every day is past
        self.this_month = self.today.replace(day=1)
        self.nadia = StaffMember.objects.create(
            clinic=c, name_en="Nadia", name_ar="نادية", staff_type="assistant", user=self.user("assist")
        )
        self.rana = StaffMember.objects.create(
            clinic=c, name_en="Rana", name_ar="رنا", staff_type="reception", user=self.user("reception")
        )
        self.hossam = StaffMember.objects.create(clinic=c, name_en="Hossam", name_ar="حسام", staff_type="other")
        for s in (self.nadia, self.rana, self.hossam, self.dentist):
            s.branches.add(self.branch)
        self.dentist2.commission_type = "fixed_per_procedure"
        self.dentist2.commission_value = 100
        self.dentist2.save()
        self.login("owner")
        self.profile(self.nadia, pay_type="monthly", base_salary="6000.00")
        self.profile(self.rana, pay_type="daily", daily_rate="300.00", payout_method="wallet", payout_account="01011112222")
        self.profile(self.hossam, pay_type="hourly", hourly_rate="50.00")
        self.profile(self.dentist, pay_type="monthly", base_salary="10000.00", insured=True, insurable_wage="5000.00")
        self.profile(self.dentist2, pay_type="commission_only")
        self.morning = self.post("/api/staff/shifts/", {
            "name_en": "Morning", "name_ar": "صباحي", "start_time": "10:00", "end_time": "18:00",
            "branch": self.branch.id, "color": "#9fd3bf",
        })

    def user(self, username):
        from erp.core.models import User  # noqa: PLC0415

        return User.objects.get(username=username)

    def day(self, n):
        return self.month + timedelta(days=n - 1)

    def post(self, url, data, expect=201):
        response = self.client.post(url, data, format="json")
        self.assertEqual(response.status_code, expect, response.content)
        return response.data

    def patch(self, url, data, expect=200):
        response = self.client.patch(url, data, format="json")
        self.assertEqual(response.status_code, expect, response.content)
        return response.data

    def profile(self, staff, **data):
        return self.patch(f"/api/staff/profiles/{staff.id}/", data)

    def roster(self, staff, n, expect=201, **extra):
        return self.post("/api/staff/roster/", {"staff": staff.id, "date": str(self.day(n)), "template": self.morning["id"], **extra}, expect)

    def attend(self, staff, n, in_time, out_time, expect=201):
        data = {"staff": staff.id, "date": str(self.day(n)), "in_time": in_time, "out_time": out_time, "reason": "Paper sheet"}
        return self.post("/api/staff/attendance/", data, expect)

    def month_of_work(self):
        """Nadia: late 25 min on day 3, 2h overtime on day 4, absent on day 5.
        Rana: in on day 3, 5 min late on day 4, absent on day 5.
        Hossam: no roster, a 10 hour day on day 3."""
        for n in (3, 4, 5):
            self.roster(self.nadia, n)
            self.roster(self.rana, n)
        self.attend(self.nadia, 3, "10:40", "18:00")
        self.attend(self.nadia, 4, "10:00", "20:00")
        self.attend(self.rana, 3, "10:00", "18:00")
        self.attend(self.rana, 4, "10:20", "18:00")
        self.attend(self.hossam, 3, "09:00", "19:00")

    def commission_this_month(self):
        """Dr Sara's root canal (2800, 30% of collected) and a whitening by Dr Omar
        (100 per procedure), invoiced and paid this month."""
        self.login("reception")
        inv = self.invoice(extra_lines=[{"description": "Whitening", "unit_price": "1000.00", "dentist": self.dentist2.id}])
        self.pay(inv, "3800.00")
        self.login("owner")

    def make_run(self, expect=201, **data):
        return self.post("/api/staff/payroll/runs/", {"month": self.month.strftime("%Y-%m"), **data}, expect)

    def line_of(self, run, staff):
        return next(x for x in run["lines"] if x["staff"] == staff.id)


class RosterTests(Phase6Base):
    def test_no_overlapping_shifts_for_one_person(self):
        first = self.roster(self.nadia, 3)
        self.assertEqual((first["start_time"], first["end_time"], first["minutes"]), ("10:00:00", "18:00:00", 480))
        self.assertEqual(first["branch"], self.branch.id)
        self.roster(self.nadia, 3, expect=400, template=None, start_time="17:00", end_time="20:00")
        self.roster(self.nadia, 3, template=None, start_time="18:00", end_time="21:00")  # back to back is fine
        self.roster(self.rana, 3)  # someone else the same day is fine
        self.roster(self.nadia, 3, expect=400, template=None)  # neither a shift nor times

    def test_week_view_and_copying_the_week_before(self):
        start = self.day(1) - timedelta(days=self.day(1).weekday()) + timedelta(days=7)
        for i in range(3):
            self.post("/api/staff/roster/", {"staff": self.nadia.id, "date": str(start + timedelta(days=i)), "template": self.morning["id"]})
        self.post("/api/staff/roster/", {"staff": self.nadia.id, "date": str(start + timedelta(days=8)), "template": self.morning["id"]})
        copied = self.post("/api/staff/roster/copy-week/", {"start": str(start + timedelta(days=7))})
        self.assertEqual((copied["created"], copied["skipped"]), (2, 1))
        week = self.client.get("/api/staff/roster/week/", {"start": str(start + timedelta(days=7))}).data
        row = next(r for r in week["rows"] if r["staff"]["id"] == self.nadia.id)
        self.assertEqual([len(d["shifts"]) for d in row["days"]], [1, 1, 1, 0, 0, 0, 0])
        self.assertEqual(row["minutes"], 3 * 480)


class AttendanceTests(Phase6Base):
    def test_late_early_and_overtime_against_the_roster(self):
        self.month_of_work()
        self.roster(self.hossam, 6)
        self.attend(self.hossam, 6, "10:10", "17:30")  # inside the grace, leaves 30 minutes early
        rows = self.client.get("/api/staff/attendance/days/", {"from": str(self.day(1)), "to": str(self.day(10))}).data["rows"]
        get = lambda s, n: next(r for r in rows if r["staff"]["id"] == s.id and r["date"] == self.day(n))  # noqa: E731
        self.assertEqual((get(self.nadia, 3)["late_minutes"], get(self.nadia, 3)["status"]), (25, "out"))
        self.assertEqual((get(self.nadia, 4)["overtime_minutes"], get(self.nadia, 4)["worked_minutes"]), (120, 600))
        self.assertEqual(get(self.nadia, 5)["status"], "absent")
        self.assertEqual(get(self.rana, 4)["late_minutes"], 5)
        self.assertEqual((get(self.hossam, 3)["overtime_minutes"], get(self.hossam, 3)["status"]), (120, "out"))  # no roster: beyond 8 hours
        sixth = get(self.hossam, 6)
        self.assertEqual((sixth["late_minutes"], sixth["early_leave_minutes"], sixth["overtime_minutes"]), (0, 30, 0))
        summary = self.client.get("/api/staff/attendance/summary/", {"month": self.month.strftime("%Y-%m")}).data["rows"]
        nadia = next(r for r in summary if r["staff"]["id"] == self.nadia.id)
        self.assertEqual(
            (nadia["rostered_days"], nadia["present_days"], nadia["absent_days"], nadia["late_minutes"], nadia["overtime_minutes"]),
            (3, 2, 1, 25, 120),
        )

    def test_manual_records_need_a_reason_and_cannot_overlap(self):
        url = "/api/staff/attendance/"
        data = {"staff": self.nadia.id, "date": str(self.day(3)), "in_time": "10:00", "out_time": "18:00"}
        self.post(url, data, expect=400)
        record = self.post(url, {**data, "reason": "Forgot to clock in"})
        self.assertEqual((record["in_local"], record["out_local"], record["minutes"], record["source"]), ("10:00", "18:00", 480, "manual"))
        self.post(url, {**data, "in_time": "17:00", "out_time": "19:00", "reason": "x"}, expect=400)
        # A night shift ends the next morning.
        night = self.post(url, {**data, "date": str(self.day(4)), "in_time": "22:00", "out_time": "02:00", "reason": "Night"})
        self.assertEqual(night["minutes"], 240)
        self.patch(f"{url}{record['id']}/", {"out_time": "18:30"}, expect=400)
        changed = self.patch(f"{url}{record['id']}/", {"out_time": "18:30", "reason": "Stayed for a patient"})
        self.assertEqual(changed["minutes"], 510)
        self.assertEqual(self.client.delete(f"{url}{record['id']}/").status_code, 400)
        self.assertEqual(self.client.delete(f"{url}{record['id']}/", {"reason": "Duplicate"}, format="json").status_code, 204)
        entries = AuditEntry.objects.filter(content_type__model="attendancerecord", object_id=str(record["id"]))
        self.assertEqual(set(entries.values_list("action", flat=True)), {"create", "update", "delete"})
        self.assertTrue(any("Duplicate" in str(e.changes) for e in entries))

    def test_self_clock_in_and_out(self):
        self.login("assist")  # not rostered right now, so signing in does not clock her in
        me = self.client.get("/api/staff/me/").data
        self.assertEqual(me["staff"]["id"], self.nadia.id)
        self.assertIsNone(me["today"]["open_record"])
        self.assertEqual(self.post("/api/staff/me/clock-in/", {})["source"], "self")
        self.post("/api/staff/me/clock-in/", {}, expect=400)  # no double clock-in
        self.assertEqual(self.client.get("/api/staff/me/").data["today"]["status"], "in")
        self.post("/api/staff/me/clock-out/", {}, expect=200)
        self.post("/api/staff/me/clock-out/", {}, expect=400)
        # Back from a break: the button clocks her in again.
        record = self.post("/api/staff/me/clock-in/", {})
        self.assertEqual(record["source"], "self")
        self.assertEqual(record["branch"], self.branch.id)  # her only branch
        self.post("/api/staff/me/clock-out/", {}, expect=200)
        self.assertEqual(AttendanceRecord.objects.filter(staff=self.nadia).count(), 2)
        # A login without a staff profile cannot clock in.
        self.login("accounts")
        self.post("/api/staff/me/clock-in/", {}, expect=403)
        self.assertEqual(self.client.get("/api/staff/me/").status_code, 403)

    def test_day_board_counts(self):
        today = self.today
        # Signing in during set-up clocked Dr Sara in; start from an empty board.
        AttendanceRecord.objects.filter(source="auto").delete()
        self.post("/api/staff/roster/", {"staff": self.nadia.id, "date": str(today), "start_time": "00:00", "end_time": "23:59"})
        self.post("/api/staff/roster/", {"staff": self.rana.id, "date": str(today), "start_time": "23:58", "end_time": "23:59"})
        self.post("/api/staff/attendance/clock/", {"staff": self.hossam.id, "action": "in"})
        board = self.client.get("/api/staff/attendance/day/").data
        status = {r["staff"]["id"]: r["status"] for r in board["rows"]}
        self.assertEqual(status[self.hossam.id], "in")
        self.assertEqual(board["counts"]["rostered"], 2)
        self.assertEqual(board["counts"]["in_now"], 1)
        summary = self.client.get("/api/staff/summary/").data
        self.assertEqual(summary["in_now"], 1)
        self.post("/api/staff/attendance/clock/", {"staff": self.hossam.id, "action": "out"}, expect=200)


class LeaveTests(Phase6Base):
    def test_request_approve_and_balance(self):
        self.login("assist")
        asked = self.post("/api/staff/me/leave/", {"kind": "annual", "start_date": str(self.day(15)), "end_date": str(self.day(17)), "reason": "Wedding"})
        self.assertEqual((asked["status"], asked["days"], asked["staff"]), ("pending", 3, self.nadia.id))
        self.post("/api/staff/me/leave/", {"kind": "sick", "start_date": str(self.day(16)), "end_date": str(self.day(16))}, expect=400)
        self.post(f"/api/staff/leave/{asked['id']}/approve/", {}, expect=403)  # cannot approve your own
        self.login("reception")
        self.assertEqual(self.client.get("/api/staff/leave/").status_code, 403)
        self.login("accounts")
        approved = self.post(f"/api/staff/leave/{asked['id']}/approve/", {"note": "Enjoy"}, expect=200)
        self.assertEqual((approved["status"], approved["decided_by_name"]), ("approved", "accounts"))
        self.post(f"/api/staff/leave/{asked['id']}/reject/", {}, expect=400)
        year = self.day(15).year
        balances = self.client.get("/api/staff/leave/balances/", {"year": year}).data["rows"]
        nadia = next(r for r in balances if r["staff"]["id"] == self.nadia.id)
        self.assertEqual((nadia["entitlement"], nadia["used"], nadia["remaining"]), (21, 3, 18))
        # A rostered day on approved leave is not an absence.
        self.roster(self.nadia, 16)
        rows = self.client.get("/api/staff/attendance/days/", {"from": str(self.day(16)), "to": str(self.day(16))}).data["rows"]
        self.assertEqual(rows[0]["status"], "leave")
        self.login("assist")
        self.assertEqual(self.client.get("/api/staff/me/").data["leave"]["balance"]["remaining"], 18)

    def test_unpaid_leave_is_deducted_from_a_monthly_salary(self):
        leave = self.post("/api/staff/leave/", {"staff": self.nadia.id, "kind": "unpaid", "start_date": str(self.day(10)), "end_date": str(self.day(11))})
        self.post(f"/api/staff/leave/{leave['id']}/approve/", {}, expect=200)
        line = self.line_of(self.make_run(), self.nadia)
        unpaid = next(i for i in line["items"] if i["kind"] == "unpaid_leave")
        self.assertEqual(unpaid["amount"], "461.54")  # 2 x 6000 / 26
        self.assertEqual(line["net"], "5538.46")


class PayrollTests(Phase6Base):
    def test_each_pay_type_with_commission_insurance_and_deductions(self):
        self.month_of_work()
        self.commission_this_month()
        self.post("/api/staff/advances/", {"staff": self.nadia.id, "date": str(self.day(1)), "amount": "1000.00", "monthly_installment": "600.00"})
        run = self.make_run(commission_month=self.this_month.strftime("%Y-%m"))
        self.assertEqual(run["status"], "draft")
        self.assertEqual(len(run["lines"]), 5)

        nadia = self.line_of(run, self.nadia)
        self.assertEqual((nadia["base_pay"], nadia["overtime_pay"]), ("6000.00", "77.88"))  # 2h x 6000/208 x 1.35
        deductions = {i["kind"]: i["amount"] for i in nadia["items"]}
        self.assertEqual(deductions, {"lateness": "12.02", "absence": "230.77", "advance": "600.00"})
        self.assertEqual((nadia["gross"], nadia["total_deductions"], nadia["net"]), ("6077.88", "842.79", "5235.09"))

        rana = self.line_of(run, self.rana)  # 2 days at 300, 5 minutes late, absence not deducted from a daily rate
        self.assertEqual((rana["base_pay"], rana["figures"]["days_worked"], rana["figures"]["absent_days"]), ("600.00", 2, 1))
        self.assertEqual([(i["kind"], i["amount"]) for i in rana["items"]], [("lateness", "3.13")])
        self.assertEqual((rana["net"], rana["payout_method"]), ("596.87", "wallet"))

        hossam = self.line_of(run, self.hossam)  # 8 hours plus 2 overtime hours at 50
        self.assertEqual((hossam["base_pay"], hossam["overtime_pay"], hossam["net"]), ("400.00", "135.00", "535.00"))

        sara = self.line_of(run, self.dentist)
        self.assertEqual((sara["base_pay"], sara["commission"]), ("10000.00", "840.00"))
        self.assertEqual((sara["employee_insurance"], sara["employer_insurance"]), ("550.00", "937.50"))
        self.assertEqual(sara["net"], "10290.00")
        self.assertEqual(sara["commission_start"], self.this_month.isoformat())

        omar = self.line_of(run, self.dentist2)
        self.assertEqual((omar["base_pay"], omar["commission"], omar["net"]), ("0.00", "100.00", "100.00"))

        totals = self.client.get(f"/api/staff/payroll/runs/{run['id']}/totals/").data
        self.assertEqual(totals["people"], 5)
        self.assertEqual(totals["net"], "16756.96")
        self.assertEqual(totals["employer_insurance"], "937.50")
        self.assertEqual(totals["cost"], str(Decimal("6077.88") + 600 + 535 + 10840 + 100 + Decimal("937.50")))

        # Commission comes from the same rule the billing report uses.
        report = {r["dentist"]: r for r in self.client.get("/api/billing/commissions/").data["rows"]}
        self.assertEqual(report[self.dentist.id]["commission"], "840.00")

    def test_manual_items_survive_recalculation_and_approval_locks(self):
        self.month_of_work()
        run = self.make_run()
        nadia = self.line_of(run, self.nadia)
        url = f"/api/staff/payroll/lines/{nadia['id']}/"
        edited = self.patch(url, {
            "income_tax": "150.00", "note": "Good month",
            "items": [{"kind": "bonus", "label": "Eid bonus", "amount": "500.00"}, {"kind": "penalty", "label": "Broken tray", "amount": "50.00"}],
        })
        self.assertEqual((edited["gross"], edited["net"]), ("6577.88", "6135.09"))
        self.patch(url, {"items": [{"kind": "lateness", "amount": "1.00"}]}, expect=400)  # worked out, not typed
        # Waive the lateness: it is no longer deducted, and stays waived.
        waived = self.patch(url, {"waived": ["lateness"]})
        self.assertNotIn("lateness", [i["kind"] for i in waived["items"]])
        self.assertEqual(waived["figures"]["worked_out"]["lateness"], "12.02")

        self.attend(self.nadia, 5, "10:00", "18:00")  # the absence was a forgotten clock-in
        run = self.post(f"/api/staff/payroll/runs/{run['id']}/recalculate/", {}, expect=200)
        nadia = self.line_of(run, self.nadia)
        kinds = sorted((i["kind"], i["amount"], i["is_manual"]) for i in nadia["items"])
        self.assertEqual(kinds, [("bonus", "500.00", True), ("penalty", "50.00", True)])
        self.assertEqual((nadia["income_tax"], nadia["note"], nadia["waived"]), ("150.00", "Good month", ["lateness"]))
        self.assertEqual(nadia["net"], "6377.88")

        self.login("accounts")
        run = self.post(f"/api/staff/payroll/runs/{run['id']}/approve/", {}, expect=200)
        self.assertEqual(run["status"], "approved")
        self.patch(url, {"note": "late change"}, expect=400)
        self.post(f"/api/staff/payroll/runs/{run['id']}/recalculate/", {}, expect=400)
        self.assertEqual(self.client.delete(f"/api/staff/payroll/runs/{run['id']}/").status_code, 403)  # accountants never delete
        self.post(f"/api/staff/payroll/runs/{run['id']}/reopen/", {}, expect=200)
        self.patch(url, {"note": "late change"})
        self.post(f"/api/staff/payroll/runs/{run['id']}/approve/", {}, expect=200)
        paid = self.post(f"/api/staff/payroll/runs/{run['id']}/pay/", {"paid_on": str(self.today), "methods": {str(nadia["id"]): "bank"}}, expect=200)
        self.assertEqual((paid["status"], self.line_of(paid, self.nadia)["payout_method"]), ("paid", "bank"))
        self.post(f"/api/staff/payroll/runs/{run['id']}/reopen/", {}, expect=400)
        self.login("owner")
        self.assertEqual(self.client.delete(f"/api/staff/payroll/runs/{run['id']}/").status_code, 400)

    def test_advance_is_taken_back_over_two_months(self):
        adv = self.post("/api/staff/advances/", {"staff": self.nadia.id, "date": str(self.day(1)), "amount": "1000.00", "monthly_installment": "600.00"})
        self.post("/api/staff/advances/", {"staff": self.nadia.id, "amount": "100.00", "monthly_installment": "200.00"}, expect=400)
        first = self.make_run()
        self.assertEqual([i["amount"] for i in self.line_of(first, self.nadia)["items"] if i["kind"] == "advance"], ["600.00"])
        # A second unpaid run does not take the same money again.
        second = self.post("/api/staff/payroll/runs/", {"month": self.this_month.strftime("%Y-%m")})
        self.assertEqual([i["amount"] for i in self.line_of(second, self.nadia)["items"] if i["kind"] == "advance"], ["400.00"])
        for run in (first, second):
            self.post(f"/api/staff/payroll/runs/{run['id']}/approve/", {}, expect=200)
        self.post(f"/api/staff/payroll/runs/{first['id']}/pay/", {"paid_on": str(self.today)}, expect=200)
        adv = self.client.get(f"/api/staff/advances/{adv['id']}/").data
        self.assertEqual((adv["repaid"], adv["remaining"], adv["status"]), ("600.00", "400.00", "active"))
        self.post(f"/api/staff/payroll/runs/{second['id']}/pay/", {"paid_on": str(self.today)}, expect=200)
        adv = self.client.get(f"/api/staff/advances/{adv['id']}/").data
        self.assertEqual((adv["remaining"], adv["status"], len(adv["repayments"])), ("0.00", "repaid", 2))
        self.assertEqual(SalaryAdvance.objects.get(pk=adv["id"]).status, "repaid")

    def test_commission_month_is_paid_once(self):
        self.commission_this_month()
        first = self.make_run(commission_month=self.this_month.strftime("%Y-%m"))
        self.assertEqual(self.line_of(first, self.dentist)["commission"], "840.00")
        second = self.post("/api/staff/payroll/runs/", {"month": self.this_month.strftime("%Y-%m")})
        sara = self.line_of(second, self.dentist)
        self.assertEqual(sara["commission"], "0.00")
        self.assertIn(self.month.strftime("%Y-%m"), sara["commission_note"])
        # One run per month, and nobody is on two runs for the same month.
        self.make_run(expect=400)
        self.make_run(expect=400, branch=self.branch.id)

    def test_new_hire_is_paid_from_the_hire_date(self):
        self.profile(self.nadia, hire_date=str(self.day(11)))
        line = self.line_of(self.make_run(), self.nadia)
        days = (add_months(self.month, 1) - self.month).days
        expected = (Decimal("6000") * (days - 10) / days).quantize(Decimal("0.01"))
        self.assertEqual(line["base_pay"], str(expected))


class PermissionTests(Phase6Base):
    def test_receptionist_sees_only_her_own_pay(self):
        run = self.make_run()
        rana_line = self.line_of(run, self.rana)
        nadia_line = self.line_of(run, self.nadia)
        self.login("reception")
        for url in ("/api/staff/payroll/runs/", "/api/staff/profiles/", "/api/staff/roster/week/", "/api/staff/dashboard/", "/api/staff/advances/"):
            self.assertEqual(self.client.get(url).status_code, 403, url)
        self.assertEqual(self.client.get(f"/api/staff/payroll/lines/{nadia_line['id']}/payslip/").status_code, 403)
        # A draft is not a payslip yet, even her own.
        self.assertEqual(self.client.get(f"/api/staff/payroll/lines/{rana_line['id']}/payslip/").status_code, 403)
        self.assertEqual(self.client.get("/api/staff/me/").data["payslips"], [])
        self.login("owner")
        self.post(f"/api/staff/payroll/runs/{run['id']}/approve/", {}, expect=200)
        self.login("reception")
        me = self.client.get("/api/staff/me/").data
        self.assertEqual([p["id"] for p in me["payslips"]], [rana_line["id"]])
        slip = self.client.get(f"/api/staff/me/payslips/{rana_line['id']}/").data
        self.assertEqual(slip["line"]["staff"], self.rana.id)
        self.assertEqual(self.client.get(f"/api/staff/me/payslips/{nadia_line['id']}/").status_code, 404)
        self.assertEqual(self.client.get(f"/api/staff/payroll/lines/{rana_line['id']}/payslip/").status_code, 200)
        # She is not on a rostered shift here, so signing in never clocked her in.
        self.assertFalse(AttendanceRecord.objects.filter(staff=self.rana).exists())

    def test_other_clinic_sees_nothing(self):
        self.make_run()
        self.login("other")
        self.assertEqual(self.client.get("/api/staff/payroll/runs/").data["results"], [])
        self.post("/api/staff/roster/", {"staff": self.nadia.id, "date": str(self.today), "start_time": "10:00", "end_time": "12:00"}, expect=400)
        self.assertEqual(self.client.patch(f"/api/staff/profiles/{self.nadia.id}/", {"base_salary": "1"}, format="json").status_code, 400)

    def test_role_defaults_and_migration(self):
        accountant = Role.objects.get(clinic=self.clinic, code="accountant")
        self.assertEqual(accountant.permissions["staff"], ["view", "create", "edit", "approve"])
        self.assertNotIn("staff", Role.objects.get(clinic=self.clinic, code="receptionist").permissions)
        accountant.permissions = {**accountant.permissions, "staff": ["view", "edit"]}
        accountant.save()
        other = Role.objects.get(clinic=self.other_clinic, code="accountant")
        other.permissions = {**other.permissions, "staff": ["view"]}
        other.save()
        migration = importlib.import_module("erp.staff.migrations.0002_role_permissions")
        migration.forwards(apps, None)
        accountant.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual(accountant.permissions["staff"], ["view", "create", "edit", "approve"])
        self.assertEqual(other.permissions["staff"], ["view"])  # hand-set rights are kept


class DashboardTests(Phase6Base):
    def test_dashboard_adds_up(self):
        self.month_of_work()
        self.commission_this_month()
        self.post("/api/staff/advances/", {"staff": self.nadia.id, "date": str(self.day(1)), "amount": "1000.00", "monthly_installment": "600.00"})
        leave = self.post("/api/staff/leave/", {"staff": self.rana.id, "kind": "sick", "start_date": str(self.day(20)), "end_date": str(self.day(21))})
        self.post(f"/api/staff/leave/{leave['id']}/approve/", {}, expect=200)
        self.make_run(commission_month=self.this_month.strftime("%Y-%m"))
        data = self.client.get("/api/staff/dashboard/", {"month": self.month.strftime("%Y-%m")}).data
        self.assertEqual((data["headcount"], data["on_payroll"]), (5, 5))
        self.assertEqual(data["payroll_cost"], "19090.38")  # gross 18152.88 + employer insurance 937.50
        self.assertEqual(data["payroll_status"], "draft")
        self.assertEqual(len(data["trend"]), 12)
        self.assertEqual(data["trend"][-1]["month"], self.month)
        self.assertEqual((data["late_minutes"], data["overtime_minutes"], data["absent_days"]), (30, 240, 2))
        self.assertEqual(data["top_late"][0]["staff"]["id"], self.nadia.id)
        self.assertEqual(data["attendance_rate"], round(4 / 6 * 100, 1))
        self.assertEqual(data["leave_by_kind"], [{"kind": "sick", "days": 2}])
        commission = {r["staff"]["id"]: r["amount"] for r in data["commission"]}
        self.assertEqual(commission, {self.dentist.id: "840.00", self.dentist2.id: "100.00"})
        self.assertEqual(data["advances_outstanding"], "1000.00")


class AutoClockInTests(Phase6Base):
    """Signing in clocks a staff member in for the day; signing out does not clock out."""

    def setUp(self):
        super().setUp()
        # Both are on shift right now (auto clock-in only happens during a rostered shift).
        now = timezone.localtime()
        start = (now - timedelta(hours=1)).time() if now.hour >= 1 else time(0, 0)
        end = (now + timedelta(hours=3)).time()
        for member in (self.nadia, self.rana):
            RosterEntry.objects.create(clinic=self.clinic, staff=member, date=self.today, start_time=start, end_time=end)

    def sign_in(self, username):
        response = self.client.post("/api/auth/token/", {"username": username, "password": PASSWORD}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        return response.data

    def test_sign_in_clocks_in_once(self):
        AttendanceRecord.objects.filter(staff=self.nadia).delete()
        data = self.sign_in("assist")
        self.assertTrue(data["auto_clocked_in"])
        self.assertTrue(data["access"])
        record = AttendanceRecord.objects.get(staff=self.nadia)
        self.assertEqual((record.source, record.date, record.clock_out), ("auto", self.today, None))
        self.assertEqual(record.branch, self.branch)
        self.assertEqual(record.created_by, self.user("assist"))  # the audit log names her
        self.assertEqual(data["clock_in_time"], timezone.localtime(record.clock_in).strftime("%H:%M"))
        # A second sign-in the same day adds nothing, even after clocking out.
        self.assertFalse(self.sign_in("assist")["auto_clocked_in"])
        record.clock_out = timezone.now()
        record.save()
        self.assertFalse(self.sign_in("assist")["auto_clocked_in"])
        self.assertEqual(AttendanceRecord.objects.filter(staff=self.nadia).count(), 1)

    def test_no_staff_profile_no_clock_in(self):
        before = AttendanceRecord.objects.count()
        data = self.sign_in("accounts")
        self.assertFalse(data["auto_clocked_in"])
        self.assertIsNone(data["clock_in"])
        self.assertEqual(AttendanceRecord.objects.count(), before)

    def test_on_approved_leave_no_clock_in(self):
        AttendanceRecord.objects.filter(staff=self.rana).delete()
        apps.get_model("staff", "LeaveRequest").objects.create(
            clinic=self.clinic, staff=self.rana, kind="sick", start_date=self.today, end_date=self.today, status="approved"
        )
        self.assertFalse(self.sign_in("reception")["auto_clocked_in"])
        self.assertFalse(AttendanceRecord.objects.filter(staff=self.rana).exists())
        # A pending request does not count.
        AttendanceRecord.objects.filter(staff=self.nadia).delete()
        apps.get_model("staff", "LeaveRequest").objects.create(
            clinic=self.clinic, staff=self.nadia, kind="annual", start_date=self.today, end_date=self.today
        )
        self.assertTrue(self.sign_in("assist")["auto_clocked_in"])

    def test_not_on_shift_no_clock_in(self):
        AttendanceRecord.objects.filter(staff=self.nadia).delete()
        RosterEntry.objects.filter(staff=self.nadia).delete()
        self.assertFalse(self.sign_in("assist")["auto_clocked_in"])
        # A shift later today that starts more than two hours from now does not count either.
        later = timezone.localtime() + timedelta(hours=3)
        if later.date() == self.today:
            RosterEntry.objects.create(
                clinic=self.clinic, staff=self.nadia, date=self.today,
                start_time=later.time(), end_time=(later + timedelta(hours=1)).time(),
            )
            self.assertFalse(self.sign_in("assist")["auto_clocked_in"])
        self.assertFalse(AttendanceRecord.objects.filter(staff=self.nadia).exists())

    def test_inactive_profile_and_wrong_password(self):
        AttendanceRecord.objects.filter(staff=self.nadia).delete()
        self.nadia.is_active = False
        self.nadia.save()
        self.assertFalse(self.sign_in("assist")["auto_clocked_in"])
        response = self.client.post("/api/auth/token/", {"username": "reception", "password": "wrong"}, format="json")
        self.assertEqual(response.status_code, 401)
        self.assertFalse(AttendanceRecord.objects.filter(staff=self.nadia).exists())
