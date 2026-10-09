from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("suppliers", views.SupplierViewSet, basename="supplier")
router.register("items", views.StockItemViewSet, basename="stockitem")
router.register("lots", views.StockLotViewSet, basename="stocklot")
router.register("movements", views.StockMovementViewSet, basename="stockmovement")
router.register("procedure-materials", views.ProcedureMaterialViewSet, basename="procedurematerial")
router.register("purchase-orders", views.PurchaseOrderViewSet, basename="purchaseorder")

urlpatterns = [
    path("adjust/", views.AdjustView.as_view(), name="inventory-adjust"),
    path("transfer/", views.TransferView.as_view(), name="inventory-transfer"),
    path("consume/", views.ConsumeView.as_view(), name="inventory-consume"),
    path("implant-trace/", views.ImplantTraceView.as_view(), name="inventory-implant-trace"),
    path("summary/", views.SummaryView.as_view(), name="inventory-summary"),
    path("report/", views.ReportView.as_view(), name="inventory-report"),
    *router.urls,
]
