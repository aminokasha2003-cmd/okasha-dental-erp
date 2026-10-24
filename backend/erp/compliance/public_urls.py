from django.urls import path

from . import public

urlpatterns = [
    path("<slug:slug>/", public.PublicClinicView.as_view(), name="public-booking"),
    path("<slug:slug>/slots/", public.PublicSlotsView.as_view(), name="public-booking-slots"),
    path("<slug:slug>/request/", public.PublicRequestView.as_view(), name="public-booking-request"),
]
