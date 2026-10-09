from django.contrib import admin

from .models import CashboxClosing, Installment, Invoice, InvoiceLine, Payment


class LineInline(admin.TabularInline):
    model = InvoiceLine
    extra = 0
    raw_id_fields = ["plan_line"]


@admin.register(Invoice)
class InvoiceAdmin(admin.ModelAdmin):
    list_display = ["number", "patient", "issue_date", "status", "clinic"]
    list_filter = ["clinic", "status"]
    raw_id_fields = ["patient"]
    inlines = [LineInline]


@admin.register(Payment)
class PaymentAdmin(admin.ModelAdmin):
    list_display = ["receipt_number", "patient", "paid_on", "amount", "method", "clinic"]
    list_filter = ["clinic", "method"]
    raw_id_fields = ["patient", "invoice"]


admin.site.register(Installment)
admin.site.register(CashboxClosing)
