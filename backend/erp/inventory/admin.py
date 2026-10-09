from django.contrib import admin

from .models import ProcedureMaterial, PurchaseOrder, PurchaseOrderLine, StockItem, StockLot, StockMovement, Supplier


@admin.register(Supplier)
class SupplierAdmin(admin.ModelAdmin):
    list_display = ["name", "contact_person", "phone", "is_active"]
    list_filter = ["is_active"]
    search_fields = ["name", "contact_person", "phone"]


@admin.register(StockItem)
class StockItemAdmin(admin.ModelAdmin):
    list_display = ["code", "name_en", "category", "unit", "last_cost", "reorder_level", "tracks_lots", "is_active"]
    list_filter = ["category", "tracks_lots", "is_active"]
    search_fields = ["code", "name_en", "name_ar", "brand"]


@admin.register(StockLot)
class StockLotAdmin(admin.ModelAdmin):
    list_display = ["item", "branch", "lot_number", "expiry_date", "quantity", "unit_cost"]
    list_filter = ["branch", "item__category"]
    search_fields = ["lot_number", "item__name_en", "item__code"]
    readonly_fields = ["quantity"]


@admin.register(StockMovement)
class StockMovementAdmin(admin.ModelAdmin):
    list_display = ["created_at", "kind", "item", "lot", "branch", "quantity", "unit_cost", "patient"]
    list_filter = ["kind", "branch"]
    search_fields = ["item__name_en", "lot__lot_number", "note"]

    def has_change_permission(self, request, obj=None):
        return False

    def has_add_permission(self, request):
        return False


@admin.register(ProcedureMaterial)
class ProcedureMaterialAdmin(admin.ModelAdmin):
    list_display = ["procedure", "item", "quantity"]
    search_fields = ["procedure__name_en", "item__name_en"]


class PurchaseOrderLineInline(admin.TabularInline):
    model = PurchaseOrderLine
    extra = 0


@admin.register(PurchaseOrder)
class PurchaseOrderAdmin(admin.ModelAdmin):
    list_display = ["number", "supplier", "branch", "status", "expected_date", "created_at"]
    list_filter = ["status", "branch"]
    search_fields = ["number", "supplier__name"]
    inlines = [PurchaseOrderLineInline]
