from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
# "alerts" first so it is not read as a patient ID.
router.register("alerts", views.MedicalAlertViewSet, basename="medical-alert")
router.register("notes", views.PatientNoteViewSet, basename="patient-note")
router.register("", views.PatientViewSet, basename="patient")

urlpatterns = router.urls
