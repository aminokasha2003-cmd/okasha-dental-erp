from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("invoices", views.InvoiceViewSet, basename="invoice")
router.register("payments", views.PaymentViewSet, basename="payment")
router.register("installments", views.InstallmentViewSet, basename="installment")
router.register("closings", views.ClosingViewSet, basename="closing")

urlpatterns = [
    path("cashbox/", views.CashboxView.as_view(), name="cashbox"),
    path("commissions/", views.CommissionReportView.as_view(), name="commissions"),
    path("patients/<int:patient_id>/account/", views.PatientAccountView.as_view(), name="patient-account"),
    *router.urls,
]
