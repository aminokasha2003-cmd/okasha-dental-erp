from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("shifts", views.ShiftTemplateViewSet, basename="shifttemplate")
router.register("roster", views.RosterViewSet, basename="roster")
router.register("attendance", views.AttendanceViewSet, basename="attendance")
router.register("leave", views.LeaveViewSet, basename="leave")
router.register("advances", views.AdvanceViewSet, basename="advance")
router.register("payroll/runs", views.PayrollRunViewSet, basename="payrollrun")
router.register("payroll/lines", views.PayrollLineViewSet, basename="payrollline")

urlpatterns = [
    path("settings/", views.SettingsView.as_view(), name="staff-settings"),
    path("profiles/", views.ProfilesView.as_view(), name="staff-profiles"),
    path("profiles/<int:staff_id>/", views.ProfileView.as_view(), name="staff-profile"),
    path("summary/", views.SummaryView.as_view(), name="staff-summary"),
    path("dashboard/", views.DashboardView.as_view(), name="staff-dashboard"),
    path("me/", views.MeView.as_view(), name="staff-me"),
    path("me/clock-in/", views.MeClockInView.as_view(), name="staff-me-clock-in"),
    path("me/clock-out/", views.MeClockOutView.as_view(), name="staff-me-clock-out"),
    path("me/leave/", views.MeLeaveView.as_view(), name="staff-me-leave"),
    path("me/leave/<int:pk>/cancel/", views.MeLeaveCancelView.as_view(), name="staff-me-leave-cancel"),
    path("me/payslips/<int:pk>/", views.MePayslipView.as_view(), name="staff-me-payslip"),
    *router.urls,
]
