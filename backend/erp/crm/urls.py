from django.urls import path
from rest_framework.routers import SimpleRouter

from . import views

router = SimpleRouter()
router.register("leads", views.LeadViewSet, basename="lead")
router.register("recall-rules", views.RecallRuleViewSet, basename="recallrule")
router.register("recall-contacts", views.RecallContactViewSet, basename="recallcontact")
router.register("campaigns", views.CampaignViewSet, basename="campaign")
router.register("feedback", views.FeedbackViewSet, basename="feedback")

urlpatterns = [
    path("summary/", views.SummaryView.as_view(), name="crm-summary"),
    path("recalls/", views.RecallQueueView.as_view(), name="crm-recalls"),
    path("patients/<int:patient_id>/", views.PatientCrmView.as_view(), name="crm-patient"),
    path("public/feedback/<str:token>/", views.PublicFeedbackView.as_view(), name="crm-public-feedback"),
    *router.urls,
]
