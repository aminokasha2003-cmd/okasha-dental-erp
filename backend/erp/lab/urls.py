from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("cases", views.LabCaseViewSet, basename="labcase")

urlpatterns = [
    path("summary/", views.LabSummaryView.as_view(), name="lab-summary"),
    path("costs/", views.LabCostReportView.as_view(), name="lab-costs"),
    path("dashboard/", views.LabDashboardView.as_view(), name="lab-dashboard"),
    *router.urls,
]
