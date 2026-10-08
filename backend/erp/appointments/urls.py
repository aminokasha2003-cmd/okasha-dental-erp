from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("", views.AppointmentViewSet, basename="appointment")

urlpatterns = router.urls
