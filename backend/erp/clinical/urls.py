from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("chart", views.ToothStateViewSet, basename="tooth")
router.register("plans", views.TreatmentPlanViewSet, basename="treatment-plan")
router.register("plan-lines", views.TreatmentPlanLineViewSet, basename="plan-line")
router.register("visit-notes", views.VisitNoteViewSet, basename="visit-note")
router.register("prescriptions", views.PrescriptionViewSet, basename="prescription")
router.register("consent-templates", views.ConsentTemplateViewSet, basename="consent-template")
router.register("consents", views.PatientConsentViewSet, basename="consent")

urlpatterns = router.urls
