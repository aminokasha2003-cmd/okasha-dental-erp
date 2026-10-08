from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register("branches", views.BranchViewSet, basename="branch")
router.register("rooms", views.RoomViewSet, basename="room")
router.register("chairs", views.ChairViewSet, basename="chair")
router.register("working-hours", views.WorkingHoursViewSet, basename="working-hours")
router.register("staff", views.StaffMemberViewSet, basename="staff")
router.register("procedure-categories", views.ProcedureCategoryViewSet, basename="procedure-category")
router.register("procedures", views.ProcedureViewSet, basename="procedure")

urlpatterns = router.urls
