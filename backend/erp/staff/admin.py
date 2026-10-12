from django.contrib import admin

from .models import (
    AttendanceRecord,
    EmploymentProfile,
    LeaveRequest,
    PayrollItem,
    PayrollLine,
    PayrollRun,
    PayrollSettings,
    RosterEntry,
    SalaryAdvance,
    ShiftTemplate,
)


@admin.register(PayrollSettings)
class PayrollSettingsAdmin(admin.ModelAdmin):
    list_display = ["clinic", "employee_insurance_rate", "employer_insurance_rate", "late_grace_minutes", "work_days_per_month"]


@admin.register(EmploymentProfile)
class EmploymentProfileAdmin(admin.ModelAdmin):
    list_display = ["staff", "pay_type", "base_salary", "daily_rate", "hourly_rate", "insured", "payout_method"]
    list_filter = ["pay_type", "insured", "payout_method"]
    search_fields = ["staff__name_en", "staff__name_ar", "national_id"]


@admin.register(ShiftTemplate)
class ShiftTemplateAdmin(admin.ModelAdmin):
    list_display = ["name_en", "start_time", "end_time", "break_minutes", "branch", "is_active"]


@admin.register(RosterEntry)
class RosterEntryAdmin(admin.ModelAdmin):
    list_display = ["date", "staff", "start_time", "end_time", "branch", "template"]
    list_filter = ["branch"]
    search_fields = ["staff__name_en"]


@admin.register(AttendanceRecord)
class AttendanceRecordAdmin(admin.ModelAdmin):
    list_display = ["date", "staff", "clock_in", "clock_out", "source", "branch"]
    list_filter = ["source", "branch"]
    search_fields = ["staff__name_en"]


@admin.register(LeaveRequest)
class LeaveRequestAdmin(admin.ModelAdmin):
    list_display = ["staff", "kind", "start_date", "end_date", "status"]
    list_filter = ["kind", "status"]


@admin.register(SalaryAdvance)
class SalaryAdvanceAdmin(admin.ModelAdmin):
    list_display = ["staff", "date", "amount", "monthly_installment", "status"]
    list_filter = ["status"]


class PayrollItemInline(admin.TabularInline):
    model = PayrollItem
    extra = 0


@admin.register(PayrollLine)
class PayrollLineAdmin(admin.ModelAdmin):
    list_display = ["run", "staff", "pay_type", "gross", "total_deductions", "net"]
    inlines = [PayrollItemInline]


@admin.register(PayrollRun)
class PayrollRunAdmin(admin.ModelAdmin):
    list_display = ["period", "branch", "status", "paid_on"]
    list_filter = ["status"]
