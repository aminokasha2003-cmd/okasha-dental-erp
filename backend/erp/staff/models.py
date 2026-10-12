"""Phase 6: staff and payroll. Pay settings per person, the clinic's payroll
rules, shift templates and the weekly roster, attendance (clock in and out),
leave, salary advances, and monthly payroll runs with one line per person."""

from datetime import datetime, timedelta
from decimal import Decimal

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from erp.core.models import ClinicScopedModel

ZERO = Decimal("0.00")
MONEY = {"max_digits": 12, "decimal_places": 2}

PAY_TYPES = [
    ("monthly", _("Monthly salary")),
    ("daily", _("Daily rate")),
    ("hourly", _("Hourly rate")),
    ("commission_only", _("Commission only")),
]
PAYOUT_METHODS = [
    ("cash", _("Cash")),
    ("bank", _("Bank transfer")),
    ("wallet", _("Mobile wallet")),
    ("instapay", _("InstaPay")),
]


def aware(day, time):
    return timezone.make_aware(datetime.combine(day, time))


class PayrollSettings(ClinicScopedModel):
    """The clinic's payroll rules. One row per clinic, made on first use."""

    employee_insurance_rate = models.DecimalField(_("employee social insurance %"), max_digits=5, decimal_places=2, default=Decimal("11.00"))
    employer_insurance_rate = models.DecimalField(_("employer social insurance %"), max_digits=5, decimal_places=2, default=Decimal("18.75"))
    late_grace_minutes = models.PositiveSmallIntegerField(_("late grace (minutes)"), default=15)
    deduct_lateness = models.BooleanField(_("deduct lateness"), default=True)
    deduct_absence = models.BooleanField(_("deduct unexcused absence"), default=True)
    work_days_per_month = models.PositiveSmallIntegerField(_("work days per month"), default=26)
    hours_per_day = models.DecimalField(_("hours per day"), max_digits=4, decimal_places=2, default=Decimal("8.00"))

    class Meta:
        verbose_name = _("payroll settings")
        verbose_name_plural = _("payroll settings")
        constraints = [models.UniqueConstraint(fields=["clinic"], name="one_payroll_settings_per_clinic")]

    def __str__(self):
        return f"Payroll settings for {self.clinic}"

    @classmethod
    def for_clinic(cls, clinic):
        obj, _created = cls.objects.get_or_create(clinic=clinic)
        return obj


class EmploymentProfile(ClinicScopedModel):
    """How one staff member is paid. Staff without a profile are left out of payroll."""

    staff = models.OneToOneField("masterdata.StaffMember", on_delete=models.CASCADE, related_name="employment")
    pay_type = models.CharField(_("pay type"), max_length=20, choices=PAY_TYPES, default="monthly")
    base_salary = models.DecimalField(_("monthly salary"), **MONEY, default=0)
    daily_rate = models.DecimalField(_("daily rate"), **MONEY, default=0)
    hourly_rate = models.DecimalField(_("hourly rate"), **MONEY, default=0)
    overtime_multiplier = models.DecimalField(_("overtime multiplier"), max_digits=4, decimal_places=2, default=Decimal("1.35"))
    hire_date = models.DateField(_("hire date"), null=True, blank=True)
    national_id = models.CharField(_("national ID"), max_length=20, blank=True)
    payout_method = models.CharField(_("payout method"), max_length=10, choices=PAYOUT_METHODS, default="cash")
    payout_account = models.CharField(_("account or wallet number"), max_length=60, blank=True)
    insured = models.BooleanField(_("socially insured"), default=False)
    insurable_wage = models.DecimalField(_("insurable wage"), **MONEY, default=0)
    annual_leave_days = models.PositiveSmallIntegerField(_("annual leave days"), default=21)
    notes = models.TextField(_("notes"), blank=True)

    class Meta:
        verbose_name = _("employment profile")
        verbose_name_plural = _("employment profiles")
        ordering = ["staff__name_en"]

    def __str__(self):
        return f"{self.staff} ({self.pay_type})"

    def daily_equivalent(self, rules):
        """One day's pay, used for absence and unpaid leave."""
        if self.pay_type == "monthly":
            return self.base_salary / rules.work_days_per_month if rules.work_days_per_month else ZERO
        if self.pay_type == "daily":
            return self.daily_rate
        if self.pay_type == "hourly":
            return self.hourly_rate * rules.hours_per_day
        return ZERO

    def hourly_equivalent(self, rules):
        """One hour's pay, used for lateness and overtime."""
        if self.pay_type == "hourly":
            return self.hourly_rate
        if not rules.hours_per_day:
            return ZERO
        return self.daily_equivalent(rules) / rules.hours_per_day


class ShiftTemplate(ClinicScopedModel):
    name_en = models.CharField(_("name (English)"), max_length=100)
    name_ar = models.CharField(_("name (Arabic)"), max_length=100)
    start_time = models.TimeField(_("starts"))
    end_time = models.TimeField(_("ends"), help_text=_("An end before the start runs past midnight."))
    break_minutes = models.PositiveSmallIntegerField(_("break (minutes)"), default=0)
    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.SET_NULL, related_name="shift_templates")
    color = models.CharField(_("colour"), max_length=7, blank=True)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("shift")
        verbose_name_plural = _("shifts")
        ordering = ["start_time", "id"]

    def __str__(self):
        return f"{self.name_en} {self.start_time:%H:%M}-{self.end_time:%H:%M}"


class RosterEntry(ClinicScopedModel):
    """One person working one shift on one day. Times are copied from the
    template so changing a template later does not rewrite past rosters."""

    staff = models.ForeignKey("masterdata.StaffMember", on_delete=models.CASCADE, related_name="roster")
    date = models.DateField(_("date"))
    template = models.ForeignKey(ShiftTemplate, null=True, blank=True, on_delete=models.SET_NULL, related_name="entries")
    start_time = models.TimeField(_("starts"))
    end_time = models.TimeField(_("ends"))
    break_minutes = models.PositiveSmallIntegerField(_("break (minutes)"), default=0)
    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.SET_NULL, related_name="roster")
    note = models.CharField(_("note"), max_length=255, blank=True)

    class Meta:
        verbose_name = _("roster entry")
        verbose_name_plural = _("roster")
        ordering = ["date", "start_time", "id"]
        indexes = [models.Index(fields=["clinic", "date"])]

    def __str__(self):
        return f"{self.staff} {self.date} {self.start_time:%H:%M}-{self.end_time:%H:%M}"

    @property
    def start_at(self):
        return aware(self.date, self.start_time)

    @property
    def end_at(self):
        end = aware(self.date, self.end_time)
        return end + timedelta(days=1) if self.end_time <= self.start_time else end

    @property
    def minutes(self):
        return max(int((self.end_at - self.start_at).total_seconds() // 60) - self.break_minutes, 0)


class AttendanceRecord(ClinicScopedModel):
    SOURCES = [
        ("self", _("Clocked by the staff member")),
        ("auto", _("Clocked in automatically at sign-in")),
        ("manual", _("Entered by a manager")),
    ]

    staff = models.ForeignKey("masterdata.StaffMember", on_delete=models.CASCADE, related_name="attendance")
    date = models.DateField(_("date"), help_text=_("The local day the record starts on."))
    clock_in = models.DateTimeField(_("clocked in"))
    clock_out = models.DateTimeField(_("clocked out"), null=True, blank=True)
    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.SET_NULL, related_name="attendance")
    source = models.CharField(_("source"), max_length=10, choices=SOURCES, default="self")
    note = models.CharField(_("note"), max_length=255, blank=True)
    edit_reason = models.CharField(_("reason for the change"), max_length=255, blank=True)

    class Meta:
        verbose_name = _("attendance record")
        verbose_name_plural = _("attendance")
        ordering = ["-date", "-clock_in", "-id"]
        indexes = [models.Index(fields=["clinic", "date"])]

    def __str__(self):
        return f"{self.staff} {self.date}"

    @property
    def minutes(self):
        if self.clock_out is None:
            return 0
        return max(int((self.clock_out - self.clock_in).total_seconds() // 60), 0)


class LeaveRequest(ClinicScopedModel):
    KINDS = [
        ("annual", _("Annual leave")),
        ("sick", _("Sick leave")),
        ("casual", _("Casual leave")),
        ("unpaid", _("Unpaid leave")),
        ("other", _("Other")),
    ]
    STATUSES = [
        ("pending", _("Pending")),
        ("approved", _("Approved")),
        ("rejected", _("Rejected")),
        ("cancelled", _("Cancelled")),
    ]

    staff = models.ForeignKey("masterdata.StaffMember", on_delete=models.CASCADE, related_name="leave_requests")
    kind = models.CharField(_("type"), max_length=10, choices=KINDS, default="annual")
    start_date = models.DateField(_("from"))
    end_date = models.DateField(_("to"))
    reason = models.CharField(_("reason"), max_length=255, blank=True)
    status = models.CharField(_("status"), max_length=10, choices=STATUSES, default="pending")
    decided_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    decided_at = models.DateTimeField(null=True, blank=True)
    decision_note = models.CharField(_("decision note"), max_length=255, blank=True)

    class Meta:
        verbose_name = _("leave request")
        verbose_name_plural = _("leave requests")
        ordering = ["-start_date", "-id"]

    def __str__(self):
        return f"{self.staff} {self.kind} {self.start_date}-{self.end_date}"


class SalaryAdvance(ClinicScopedModel):
    """Money paid ahead of salary (سلفة), taken back in monthly installments."""

    STATUSES = [("active", _("Being repaid")), ("repaid", _("Repaid")), ("cancelled", _("Cancelled"))]

    staff = models.ForeignKey("masterdata.StaffMember", on_delete=models.PROTECT, related_name="advances")
    date = models.DateField(_("date"), default=timezone.localdate)
    amount = models.DecimalField(_("amount"), **MONEY)
    monthly_installment = models.DecimalField(_("monthly installment"), **MONEY)
    reason = models.CharField(_("reason"), max_length=255, blank=True)
    status = models.CharField(_("status"), max_length=10, choices=STATUSES, default="active")

    class Meta:
        verbose_name = _("salary advance")
        verbose_name_plural = _("salary advances")
        ordering = ["-date", "-id"]

    def __str__(self):
        return f"{self.staff} {self.amount}"

    @property
    def repaid(self):
        return sum((r.amount for r in self.repayments.all()), ZERO)

    @property
    def remaining(self):
        return ZERO if self.status == "cancelled" else max(self.amount - self.repaid, ZERO)


class PayrollRun(ClinicScopedModel):
    STATUSES = [("draft", _("Draft")), ("approved", _("Approved")), ("paid", _("Paid"))]

    period = models.DateField(_("month"), help_text=_("The first day of the month paid."))
    branch = models.ForeignKey("masterdata.Branch", null=True, blank=True, on_delete=models.PROTECT, related_name="payroll_runs")
    commission_period = models.DateField(_("commission month"), help_text=_("The month whose commission this run pays."))
    status = models.CharField(_("status"), max_length=10, choices=STATUSES, default="draft")
    notes = models.TextField(_("notes"), blank=True)
    calculated_at = models.DateTimeField(null=True, blank=True)
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    approved_at = models.DateTimeField(null=True, blank=True)
    paid_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    paid_on = models.DateField(_("paid on"), null=True, blank=True)

    class Meta:
        verbose_name = _("payroll run")
        verbose_name_plural = _("payroll runs")
        ordering = ["-period", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["clinic", "period", "branch"], name="one_payroll_run_per_month_branch", nulls_distinct=False)
        ]

    def __str__(self):
        return f"Payroll {self.period:%Y-%m}"


class PayrollLine(ClinicScopedModel):
    """One person on one payroll run. Worked-out figures are stored so an
    approved run never changes; manual items and the tax survive a recalculation."""

    run = models.ForeignKey(PayrollRun, on_delete=models.CASCADE, related_name="lines")
    staff = models.ForeignKey("masterdata.StaffMember", on_delete=models.PROTECT, related_name="payroll_lines")
    pay_type = models.CharField(_("pay type"), max_length=20, choices=PAY_TYPES)
    rate = models.DecimalField(_("salary or rate"), **MONEY, default=0)
    figures = models.JSONField(_("attendance figures"), default=dict, blank=True)
    base_pay = models.DecimalField(_("base pay"), **MONEY, default=0)
    overtime_pay = models.DecimalField(_("overtime pay"), **MONEY, default=0)
    commission = models.DecimalField(_("commission"), **MONEY, default=0)
    commission_start = models.DateField(null=True, blank=True)
    commission_end = models.DateField(null=True, blank=True)
    commission_note = models.CharField(max_length=255, blank=True)
    employee_insurance = models.DecimalField(_("employee social insurance"), **MONEY, default=0)
    employer_insurance = models.DecimalField(_("employer social insurance"), **MONEY, default=0)
    income_tax = models.DecimalField(_("income tax"), **MONEY, default=0)
    waived = models.JSONField(_("waived deductions"), default=list, blank=True)
    gross = models.DecimalField(_("gross"), **MONEY, default=0)
    total_deductions = models.DecimalField(_("deductions"), **MONEY, default=0)
    net = models.DecimalField(_("net pay"), **MONEY, default=0)
    payout_method = models.CharField(_("payout method"), max_length=10, choices=PAYOUT_METHODS, default="cash")
    payout_account = models.CharField(_("account or wallet number"), max_length=60, blank=True)
    note = models.CharField(_("note"), max_length=255, blank=True)

    class Meta:
        verbose_name = _("payroll line")
        verbose_name_plural = _("payroll lines")
        ordering = ["staff__name_en", "id"]
        constraints = [models.UniqueConstraint(fields=["run", "staff"], name="one_line_per_person_per_run")]

    def __str__(self):
        return f"{self.run}: {self.staff}"

    @property
    def additions(self):
        return sum((i.amount for i in self.items.all() if i.direction == "add"), ZERO)

    @property
    def item_deductions(self):
        return sum((i.amount for i in self.items.all() if i.direction == "deduct"), ZERO)

    def total(self):
        """Work out gross, deductions and net from the stored parts and items."""
        self.gross = self.base_pay + self.overtime_pay + self.commission + self.additions
        self.total_deductions = self.employee_insurance + self.income_tax + self.item_deductions
        self.net = self.gross - self.total_deductions


class PayrollItem(models.Model):
    """An addition or deduction on a payroll line. Worked-out items (lateness,
    absence, unpaid leave, advance installments) are replaced on every
    recalculation; manual ones are kept."""

    KINDS = [
        ("bonus", _("Bonus")),
        ("allowance", _("Allowance")),
        ("other_addition", _("Other addition")),
        ("lateness", _("Lateness")),
        ("absence", _("Unexcused absence")),
        ("unpaid_leave", _("Unpaid leave")),
        ("advance", _("Advance installment")),
        ("penalty", _("Penalty")),
        ("other_deduction", _("Other deduction")),
    ]
    ADDITIONS = ("bonus", "allowance", "other_addition")
    AUTO = ("lateness", "absence", "unpaid_leave", "advance")
    WAIVABLE = ("lateness", "absence", "unpaid_leave")

    line = models.ForeignKey(PayrollLine, on_delete=models.CASCADE, related_name="items")
    kind = models.CharField(_("kind"), max_length=20, choices=KINDS)
    label = models.CharField(_("label"), max_length=120, blank=True)
    amount = models.DecimalField(_("amount"), **MONEY)
    is_manual = models.BooleanField(default=True)
    advance = models.ForeignKey(SalaryAdvance, null=True, blank=True, on_delete=models.PROTECT, related_name="payroll_items")

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return f"{self.kind} {self.amount}"

    @property
    def direction(self):
        return "add" if self.kind in self.ADDITIONS else "deduct"


class AdvanceRepayment(models.Model):
    advance = models.ForeignKey(SalaryAdvance, on_delete=models.CASCADE, related_name="repayments")
    line = models.ForeignKey(PayrollLine, null=True, blank=True, on_delete=models.SET_NULL, related_name="repayments")
    date = models.DateField(_("date"))
    amount = models.DecimalField(_("amount"), **MONEY)

    class Meta:
        ordering = ["date", "id"]
