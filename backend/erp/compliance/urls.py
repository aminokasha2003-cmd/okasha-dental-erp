from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("equipment", views.EquipmentViewSet, basename="equipment")
router.register("plans", views.PlanViewSet, basename="maintenanceplan")
router.register("records", views.RecordViewSet, basename="maintenancerecord")
router.register("work-orders", views.WorkOrderViewSet, basename="workorder")
router.register("licences", views.LicenceViewSet, basename="licence")
router.register("packs", views.PackViewSet, basename="pack")
router.register("cycles", views.CycleViewSet, basename="cycle")
router.register("checklists", views.ChecklistViewSet, basename="checklist")
router.register("einvoice/documents", views.DocumentViewSet, basename="einvoicedocument")
router.register("booking/requests", views.BookingRequestViewSet, basename="bookingrequest")

urlpatterns = [
    path("summary/", views.SummaryView.as_view(), name="compliance-summary"),
    path("settings/", views.SettingsView.as_view(), name="compliance-settings"),
    path("dashboard/", views.DashboardView.as_view(), name="compliance-dashboard"),
    path("chairs-down/", views.ChairsDownView.as_view(), name="compliance-chairs-down"),
    path("bi-status/", views.BiStatusView.as_view(), name="compliance-bi-status"),
    path("trace/patient/<int:patient_id>/", views.PatientTraceView.as_view(), name="compliance-patient-trace"),
    path("einvoice/settings/", views.EInvoiceSettingsView.as_view(), name="einvoice-settings"),
    path("einvoice/item-codes/", views.ItemCodesView.as_view(), name="einvoice-item-codes"),
    path("booking/settings/", views.BookingSettingsView.as_view(), name="booking-settings"),
    *router.urls,
]
